import { fileURLToPath } from 'node:url';

import { RealCodexAdapter } from './codex-adapter.js';
import { loadModelCatalog, loadServerConfig } from './config.js';
import { Repository } from './database.js';
import { buildDiagnosticExport } from './diagnostic-export.js';
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
try {
  const report = await buildDiagnosticExport({ config, repository, workspaces, adapter, models });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  repository.close();
}
