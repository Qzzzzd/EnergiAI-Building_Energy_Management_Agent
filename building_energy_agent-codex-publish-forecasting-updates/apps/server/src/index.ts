import { fileURLToPath } from 'node:url';

import { createApplication } from './app.js';
import { loadServerConfig } from './config.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadServerConfig(projectRoot);
const { app } = await createApplication({ config });

await app.listen({ host: config.host, port: config.port });
process.stdout.write(
  `${JSON.stringify({ service: 'building-energy-server', address: `http://${config.host}:${config.port}`, health: '/api/v1/health' })}\n`,
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
