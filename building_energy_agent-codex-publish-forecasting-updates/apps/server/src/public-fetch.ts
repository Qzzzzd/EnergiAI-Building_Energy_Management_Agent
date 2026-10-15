#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';

import { sessionSocketPath } from './workspace.js';

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (!key?.startsWith('--')) continue;
  const next = args[index + 1];
  if (next && !next.startsWith('--')) {
    values.set(key.slice(2), next);
    index += 1;
  } else {
    values.set(key.slice(2), 'true');
  }
}

const target = values.get('url');
const method = values.has('head') ? 'HEAD' : 'GET';
const output = values.get('output');
if (!target || (method === 'GET' && !output)) {
  process.stderr.write(
    'usage: building-energy-public-fetch --url <https-url> --output <relative-path> [--head]\n',
  );
  process.exitCode = 2;
} else {
  const socketPath = process.env.BE_PUBLIC_READ_SOCKET ?? inferSessionSocket(process.cwd());
  const query = new URLSearchParams({ url: target, method, ...(output ? { output } : {}) });
  const request = http.request(
    { socketPath, path: `/fetch?${query.toString()}`, method: 'GET' },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) {
          process.stderr.write(`${body}\n`);
          process.exitCode = 1;
        } else {
          process.stdout.write(`${body}\n`);
        }
      });
    },
  );
  request.once('error', (error) => {
    process.stderr.write(`public-fetch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  request.end();
}

function inferSessionSocket(workingDirectory: string): string {
  const workspace = path.resolve(workingDirectory);
  const sessionRoot = path.dirname(workspace);
  const sessionId = path.basename(sessionRoot);
  const runtimeRoot = path.dirname(path.dirname(sessionRoot));
  return sessionSocketPath(runtimeRoot, sessionId);
}
