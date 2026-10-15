import { fileURLToPath } from 'node:url';

import { RealCodexAdapter } from './codex-adapter.js';
import { loadModelCatalog, loadServerConfig } from './config.js';
import { Repository } from './database.js';
import { doctorChecks, overallStatus } from './diagnostics.js';
import { WorkspaceManager } from './workspace.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadServerConfig(projectRoot);
const repository = new Repository(config.databasePath);
const workspaces = new WorkspaceManager(config.runtimeRoot);
await workspaces.initialize();
repository.migrate();
const models = await loadModelCatalog(config.modelsPath);
const adapter = new RealCodexAdapter({
  projectRoot,
  ...(config.codexPath ? { codexPath: config.codexPath } : {}),
  ...(models.codex ? { baseUrl: models.codex.baseUrl, apiKey: models.codex.apiKey } : {}),
});
const checks = await doctorChecks({
  config,
  repository,
  workspaces,
  adapter,
  models: models.models,
});
const status = overallStatus(checks);
process.stdout.write(
  `${JSON.stringify({ api_version: '1.0', status, generated_at: new Date().toISOString(), checks }, null, 2)}\n`,
);
repository.close();
if (status === 'unavailable') process.exitCode = 1;
