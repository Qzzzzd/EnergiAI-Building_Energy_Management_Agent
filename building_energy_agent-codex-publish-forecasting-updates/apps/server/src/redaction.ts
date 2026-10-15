import path from 'node:path';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|sess|pat|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password)\b\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ABSOLUTE_PATH = /(?:^|[\s"'`(])\/(?:home|root|tmp|var|opt|etc|proc|sys|run|mnt)\/[^\s"'`)]*/g;
const OTHER_ABSOLUTE_PATH =
  /(?:^|[\s"'`(])(?:[A-Za-z]:\\|\/(?!api\/))[A-Za-z0-9._-]+(?:[\\/][^\s"'`)]*)+/g;
const CREDENTIALED_URL = /\bhttps?:\/\/[^\s\/:@]+:[^\s\/@]+@/gi;
const PROXY_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

export function redactText(input: unknown, maxBytes = 8_000, maxLines = 80): string {
  let value = typeof input === 'string' ? input : safeStringify(input);
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const configured = process.env[key];
    if (configured) value = value.replaceAll(configured, '[REDACTED_PROXY]');
  }
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[REDACTED]');
  value = value.replace(CREDENTIALED_URL, '[REDACTED_URL]');
  value = value.replace(ABSOLUTE_PATH, (match) => {
    const prefix = /^[\s"'`(]/.test(match) ? match[0] : '';
    return `${prefix}[PATH_REDACTED]`;
  });
  value = value.replace(OTHER_ABSOLUTE_PATH, (match) => {
    const prefix = /^[\s"'`(]/.test(match) ? match[0] : '';
    return `${prefix}[PATH_REDACTED]`;
  });
  const lines = value.split(/\r?\n/).slice(0, maxLines).join('\n');
  const bytes = Buffer.from(lines);
  return bytes.length <= maxBytes
    ? lines
    : `${bytes.subarray(0, maxBytes).toString('utf8')}…[TRUNCATED]`;
}

export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[INVALID_URL]';
  }
}

export function publicPathLabel(filePath: string): string {
  return (
    path
      .basename(filePath)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'file'
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

export interface SafeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function createSafeLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
) {
  const emit = (level: string, fields: Record<string, unknown>, message: string) => {
    write(`${JSON.stringify(safeLogRecord(level, fields, message))}\n`);
  };
  return {
    info: (fields: Record<string, unknown>, message: string) => emit('info', fields, message),
    warn: (fields: Record<string, unknown>, message: string) => emit('warn', fields, message),
    error: (fields: Record<string, unknown>, message: string) => emit('error', fields, message),
  } satisfies SafeLogger;
}

export function createRotatingJsonlLogger(
  directory: string,
  options: { maxBytes: number; backups: number },
): SafeLogger {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logPath = path.join(directory, 'server.jsonl');
  const write = (line: string) => {
    let currentSize = 0;
    try {
      currentSize = statSync(logPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (currentSize + Buffer.byteLength(line) > options.maxBytes) {
      rotateFiles(logPath, options.backups);
    }
    appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  };
  return createSafeLogger(write);
}

function safeLogRecord(level: string, fields: Record<string, unknown>, message: string) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, safeLogValue(value)]),
  );
  return {
    timestamp: new Date().toISOString(),
    level,
    message: redactText(message, 1_000, 10),
    ...safeFields,
  };
}

function safeLogValue(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return redactText(value, 1_000, 10);
}

function rotateFiles(logPath: string, backups: number): void {
  if (backups <= 0) {
    rmSync(logPath, { force: true });
    return;
  }
  rmSync(`${logPath}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
