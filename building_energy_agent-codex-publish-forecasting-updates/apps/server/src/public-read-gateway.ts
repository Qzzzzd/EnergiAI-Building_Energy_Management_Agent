import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { chmod, open, rename, rm, unlink } from 'node:fs/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

import { redactUrl, type SafeLogger } from './redaction.js';
import type { ServerConfig } from './types.js';
import { WorkspaceManager } from './workspace.js';

export class PublicReadError extends Error {
  constructor(
    readonly code:
      | 'METHOD_NOT_ALLOWED'
      | 'INVALID_URL'
      | 'SSRF_BLOCKED'
      | 'REDIRECT_BLOCKED'
      | 'RESPONSE_TOO_LARGE'
      | 'UNSUPPORTED_CONTENT_TYPE'
      | 'TIMEOUT'
      | 'UPSTREAM_ERROR'
      | 'OUTPUT_PATH_INVALID',
    message: string,
  ) {
    super(message);
  }
}

export interface PublicReadResult {
  source_url: string;
  status: number;
  media_type: string;
  size_bytes: number;
  sha256?: string;
  output?: string;
  redirects: number;
  duration_ms: number;
}

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
export type PublicReadTransport = (
  url: URL,
  method: 'GET' | 'HEAD',
  target: { address: string; family: 4 | 6 },
  timeoutMs: number,
) => Promise<{
  statusCode?: number | undefined;
  headers: IncomingHttpHeaders;
  resume(): unknown;
  destroy(error?: Error): unknown;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | Buffer | string>;
}>;

export class PublicReadGateway {
  private server: Server | null = null;

  constructor(
    readonly sessionId: string,
    private readonly workspaces: WorkspaceManager,
    private readonly options: ServerConfig['publicRead'],
    private readonly logger: SafeLogger,
    private readonly onActivity: (summary: string, detail?: string) => void,
    private readonly resolver: Resolver = resolveHost,
    private readonly requester: PublicReadTransport = requestPinned,
  ) {}

  async start(): Promise<string> {
    if (this.server) return this.workspaces.paths(this.sessionId).socket;
    const paths = await this.workspaces.createSession(this.sessionId);
    await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const server = http.createServer((request, response) => {
      void this.handleLocalRequest(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(paths.socket, () => {
          server.off('error', reject);
          resolve();
        });
      });
      await chmod(paths.socket, 0o600);
      this.server = server;
      return paths.socket;
    } catch (error) {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await unlink(paths.socket).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await unlink(this.workspaces.paths(this.sessionId).socket).catch(() => undefined);
  }

  async fetch(input: {
    url: string;
    method: 'GET' | 'HEAD';
    output?: string;
  }): Promise<PublicReadResult> {
    if (input.method !== 'GET' && input.method !== 'HEAD') {
      throw new PublicReadError('METHOD_NOT_ALLOWED', '公开读取只允许 GET 或 HEAD。');
    }
    if (input.method === 'GET' && !input.output) {
      throw new PublicReadError('OUTPUT_PATH_INVALID', 'GET 必须指定当前会话工作区内的输出路径。');
    }
    const started = Date.now();
    let current = parsePublicUrl(input.url);
    let redirects = 0;
    for (;;) {
      const addresses = await this.resolver(current.hostname);
      if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
        throw new PublicReadError('SSRF_BLOCKED', '目标解析到私有、保留或不可路由地址。');
      }
      const response = await this.requester(
        current,
        input.method,
        addresses[0]!,
        this.options.timeoutMs,
      );
      if (isRedirect(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects >= this.options.maxRedirects) {
          throw new PublicReadError('REDIRECT_BLOCKED', '重定向链缺失目标或超过限制。');
        }
        current = parsePublicUrl(new URL(location, current).toString());
        redirects += 1;
        continue;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new PublicReadError(
          'UPSTREAM_ERROR',
          `公开来源返回 HTTP ${response.statusCode ?? 0}。`,
        );
      }
      const mediaType = validateContentType(response.headers, this.options.allowedMediaTypes);
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > this.options.maxBytes) {
        response.destroy();
        throw new PublicReadError('RESPONSE_TOO_LARGE', '公开响应超过大小限制。');
      }
      let size = 0;
      let sha256: string | undefined;
      if (input.method === 'HEAD') {
        response.resume();
      } else {
        const output = this.workspaces.resolveWorkspaceWrite(this.sessionId, input.output!);
        await this.workspaces.assertWritableTarget(
          this.workspaces.paths(this.sessionId).workspace,
          output,
        );
        const temp = path.join(path.dirname(output), `.public-read-${randomUUID()}.partial`);
        await this.workspaces.assertWritableTarget(
          this.workspaces.paths(this.sessionId).workspace,
          temp,
        );
        const file = await open(temp, 'wx', 0o600);
        const hash = createHash('sha256');
        try {
          for await (const chunkValue of response) {
            const chunk = Buffer.from(chunkValue);
            size += chunk.length;
            if (size > this.options.maxBytes) {
              response.destroy();
              throw new PublicReadError('RESPONSE_TOO_LARGE', '公开响应超过大小限制。');
            }
            hash.update(chunk);
            await file.write(chunk);
          }
          await file.sync();
        } catch (error) {
          await rm(temp, { force: true });
          throw error;
        } finally {
          await file.close();
        }
        sha256 = hash.digest('hex');
        await rename(temp, output).catch(async (error) => {
          await rm(temp, { force: true });
          throw error;
        });
        const provenancePath = this.workspaces.resolveWorkspaceWrite(
          this.sessionId,
          `${input.output!}.source.json`,
        );
        await this.workspaces.assertWritableTarget(
          this.workspaces.paths(this.sessionId).workspace,
          provenancePath,
        );
        const provenance = await open(provenancePath, 'wx', 0o600);
        try {
          await provenance.writeFile(
            `${JSON.stringify({
              source_url: redactUrl(current.toString()),
              status: response.statusCode,
              media_type: mediaType,
              size_bytes: size,
              sha256,
              fetched_at: new Date().toISOString(),
            })}\n`,
          );
        } finally {
          await provenance.close();
        }
      }
      const result: PublicReadResult = {
        source_url: redactUrl(current.toString()),
        status: response.statusCode,
        media_type: mediaType,
        size_bytes: input.method === 'HEAD' ? declaredLength : size,
        ...(sha256 ? { sha256 } : {}),
        ...(input.output ? { output: input.output } : {}),
        redirects,
        duration_ms: Date.now() - started,
      };
      this.logger.info(
        {
          session_id: this.sessionId,
          source: result.source_url,
          status: result.status,
          size: result.size_bytes,
          duration_ms: result.duration_ms,
        },
        'public read completed',
      );
      this.onActivity(
        `读取公开来源：${result.source_url}`,
        `HTTP ${result.status} · ${result.media_type} · ${result.size_bytes} bytes · ${result.duration_ms} ms`,
      );
      return result;
    }
  }

  private async handleLocalRequest(
    request: IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const credentialHeader = Object.keys(request.headers).find((name) =>
        /(?:authorization|cookie|api[-_]?key|token|credential|secret)/i.test(name),
      );
      if (request.method !== 'GET' || credentialHeader) {
        throw new PublicReadError('METHOD_NOT_ALLOWED', '本地网关接口只接受无认证信息的 GET。');
      }
      if (
        request.headers['transfer-encoding'] !== undefined ||
        Number(request.headers['content-length'] ?? 0) !== 0
      ) {
        throw new PublicReadError('METHOD_NOT_ALLOWED', '本地网关接口不接受请求体。');
      }
      const localUrl = new URL(request.url ?? '/', 'http://unix.local');
      if (localUrl.pathname !== '/fetch') {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const target = localUrl.searchParams.get('url');
      const method = localUrl.searchParams.get('method') ?? 'GET';
      const output = localUrl.searchParams.get('output') ?? undefined;
      if (!target || (method !== 'GET' && method !== 'HEAD')) {
        throw new PublicReadError('INVALID_URL', 'url 或 method 参数无效。');
      }
      const result = await this.fetch({ url: target, method, ...(output ? { output } : {}) });
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      const gatewayError =
        error instanceof PublicReadError
          ? error
          : new PublicReadError('UPSTREAM_ERROR', '公开读取失败。');
      response.statusCode = gatewayError.code === 'METHOD_NOT_ALLOWED' ? 405 : 400;
      response.end(JSON.stringify({ error: gatewayError.code, detail: gatewayError.message }));
    }
  }
}

export class PublicReadGatewayManager {
  private readonly gateways = new Map<string, PublicReadGateway>();

  constructor(
    private readonly workspaces: WorkspaceManager,
    private readonly options: ServerConfig['publicRead'],
    private readonly logger: SafeLogger,
    private readonly onActivity: (sessionId: string, summary: string, detail?: string) => void,
  ) {}

  async start(sessionId: string): Promise<PublicReadGateway> {
    const existing = this.gateways.get(sessionId);
    if (existing) return existing;
    const gateway = new PublicReadGateway(
      sessionId,
      this.workspaces,
      this.options,
      this.logger,
      (summary, detail) => this.onActivity(sessionId, summary, detail),
    );
    await gateway.start();
    this.gateways.set(sessionId, gateway);
    return gateway;
  }

  async stop(sessionId: string): Promise<void> {
    const gateway = this.gateways.get(sessionId);
    if (!gateway) return;
    this.gateways.delete(sessionId);
    await gateway.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.gateways.values()].map((gateway) => gateway.close()));
    this.gateways.clear();
  }
}

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicReadError('INVALID_URL', '公开读取 URL 无效。');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname.length === 0
  ) {
    throw new PublicReadError('INVALID_URL', '只允许无凭据的 HTTP(S) URL。');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if ((url.protocol === 'https:' && port !== 443) || (url.protocol === 'http:' && port !== 80)) {
    throw new PublicReadError('SSRF_BLOCKED', '只允许标准 HTTP/HTTPS 端口。');
  }
  if (url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.local')) {
    throw new PublicReadError('SSRF_BLOCKED', '本地域名不可访问。');
  }
  if (net.isIP(url.hostname) && isBlockedAddress(url.hostname)) {
    throw new PublicReadError('SSRF_BLOCKED', '私有或保留地址不可访问。');
  }
  return url;
}

async function resolveHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
}

export function isBlockedAddress(input: string): boolean {
  const address = input.toLowerCase().split('%', 1)[0]!;
  if (address.startsWith('::ffff:')) return isBlockedAddress(address.slice(7));
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88) ||
      (a === 192 && b === 0 && address.startsWith('192.0.2.')) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const first = Number.parseInt(address.split(':', 1)[0] || '0', 16);
    return (
      address === '::' ||
      address === '::1' ||
      first < 0x2000 ||
      first > 0x3fff ||
      address.startsWith('fc') ||
      address.startsWith('fd') ||
      /^fe[89ab]/.test(address) ||
      address.startsWith('ff') ||
      address === '2001::' ||
      address.startsWith('2001:0:') ||
      address.startsWith('2001:10:') ||
      address.startsWith('2001:20:') ||
      address.startsWith('2001:db8:') ||
      address.startsWith('2002:')
    );
  }
  return true;
}

function requestPinned(
  url: URL,
  method: 'GET' | 'HEAD',
  target: { address: string; family: 4 | 6 },
  timeoutMs: number,
): Promise<IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const request = client.request(
      url,
      {
        method,
        headers: {
          accept: 'text/*,application/json,application/xml,application/pdf;q=0.8,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'building-energy-public-read/1.0',
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
        },
      },
      (response) => {
        response.once('close', () => {
          if (timer) clearTimeout(timer);
        });
        resolve(response);
      },
    );
    timer = setTimeout(() => {
      request.destroy(new PublicReadError('TIMEOUT', '公开读取请求超时。'));
    }, timeoutMs);
    request.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && [301, 302, 303, 307, 308].includes(status);
}

function validateContentType(headers: IncomingHttpHeaders, allowed: string[]): string {
  const raw = headers['content-type'];
  const mediaType = (Array.isArray(raw) ? raw[0] : raw)?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !mediaType ||
    !allowed.some((candidate) =>
      candidate.endsWith('/') ? mediaType.startsWith(candidate) : mediaType === candidate,
    )
  ) {
    throw new PublicReadError('UNSUPPORTED_CONTENT_TYPE', '公开响应内容类型不在允许列表中。');
  }
  return mediaType;
}
