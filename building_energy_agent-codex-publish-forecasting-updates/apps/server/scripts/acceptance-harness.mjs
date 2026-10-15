import { fileURLToPath } from 'node:url';

import { createApplication } from '../dist/app.js';
import { loadServerConfig } from '../dist/config.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadServerConfig(projectRoot);
const threadId = 'acceptance-multi-question-thread';

const adapter = {
  async runTurn(request) {
    const isResume = request.content.includes('question_set_id=');
    if (isResume && request.threadId !== threadId) {
      throw new Error('acceptance resume did not retain the original thread');
    }
    await request.onThreadStarted(threadId);
    if (!isResume) {
      return {
        threadId,
        envelope: {
          status: 'needs_input',
          message: '需要同时确认时区与目标测点。',
          questions: [
            {
              id: 'timezone',
              question: '这份数据使用哪个时区？',
              options: ['Asia/Shanghai', 'UTC'],
              allow_free_text: false,
              required: true,
            },
            {
              id: 'target',
              question: '要分析哪个目标测点？',
              options: [],
              allow_free_text: true,
              required: true,
            },
          ],
        },
      };
    }
    return {
      threadId,
      envelope: {
        status: 'completed',
        message: '问题组回答已在同一 Codex thread 中恢复并完成。',
        result_refs: [],
      },
      usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 24 },
    };
  },
  async diagnose() {
    return [
      {
        name: 'codex-cli',
        status: 'ready',
        version: 'deterministic-acceptance-harness',
        capability_summary: '仅用于浏览器问题组、持久化与恢复验收；不生成业务结果',
      },
    ];
  },
};

const { app } = await createApplication({ config, adapter });
await app.listen({ host: config.host, port: config.port });
process.stdout.write(
  `${JSON.stringify({ service: 'building-energy-server', mode: 'acceptance-harness', address: `http://${config.host}:${config.port}` })}\n`,
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
