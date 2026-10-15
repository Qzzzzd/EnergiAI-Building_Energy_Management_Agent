## Why

现有建筑能源 Web Agent 将模型路由、固定任务图和 Skill 调用建立在 OpenAI Agents SDK 与自定义 Runtime 之上，导致 Codex 自身的线程、Skills、流式活动和沙箱能力无法成为产品的一等能力。现在需要在独立仓库中建立一个 Codex-native、聊天优先的单用户 Web Agent：保留四个确定性建筑能源算法，同时让未来 Skill 可以按 Codex 原生发现机制安装和执行，而无需继续扩展后端业务编排代码。

## What Changes

- 新建独立的 TypeScript monorepo，以 React Web、Node.js 后端和 `@openai/codex-sdk` 组成首版运行时；旧项目保持只读参考，不迁移 API、历史会话或 Runtime 代码。
- 以“一个 Web 对话 = 一个 Codex thread = 一个隔离会话目录”管理聊天、模型选择、流式活动、取消、重启恢复和本地产物。
- 让 Codex 自主理解意图、规划并选择仓库级 `.agents/skills`；后端只提供通用会话、安全、事件、文件和 artifact 能力，不维护固定 Skill Registry 或业务任务图。
- 将旧项目提交 `a0d0395` 中的四个确定性 Python 算法迁移为可发现的 Codex Skills，统一计算型 Skill 的 lifecycle、进度、错误和 Bundle/manifest 交接协议。
- 支持 `.xlsx`、只读 `.xlsm`、长表 CSV 和宽表 CSV；限制最多 10 个文件、单文件 200 MB、单次上传总计 200 MB，并为每次上传建立不可变快照。
- 提供中文优先、三栏聊天界面：主对话、结构化多问题卡、可展开的 Codex 活动时间线、结果摘要、专业详情和受控 artifact 下载；视觉和交互适当参考旧项目，但不复制其单体组件、固定流程导航或累积式样式结构。
- 使用 REST 处理命令和资源，使用可续传 SSE 发布稳定的业务事件；以共享 Zod Schema 生成 OpenAPI 与前端类型。
- 使用 `workspace-write` 会话沙箱和预定义权限运行 Codex；允许公开互联网只读检索，但禁止数据外传、外部写操作、未知凭据使用和运行时依赖安装。
- 提供原生 DGX/Linux 的安装、开发、启动、健康检查与诊断流程，并以真实四 Skill 测试、三业务流、取消、恢复、格式解析和可插拔测试 Skill 作为完成门槛。
- **BREAKING**：新项目不兼容旧项目的 REST/SSE 契约、会话数据、Job 状态或 OpenAI Agents SDK Runtime；二者是独立系统。

## Capabilities

### New Capabilities

- `codex-session-runtime`: Codex SDK thread 生命周期、模型与 reasoning 选择、会话沙箱、联网策略、取消、中断和重启恢复。
- `dynamic-skill-runtime`: 仓库级 Skill 自动发现、计算型 Skill 通用 lifecycle、零后端专用编排以及可扩展安装边界。
- `building-energy-data-ingestion`: XLSX/XLSM/CSV 上传、不可变快照、确定性解析、格式安全和 DatasetBundle 生成。
- `building-energy-analysis`: 负荷预测、数据质量评估和综合任务的 Skill 前置关系、默认业务语义、Bundle 交接与确定性结果权威。
- `conversation-experience`: 聊天、结构化多问题确认、丰富且脱敏的 Agent 活动、结果展示、会话管理和响应式交互。
- `platform-contracts-and-operations`: REST/SSE 契约、事件续传、artifact 服务、健康诊断、日志、原生部署和验收边界。

### Modified Capabilities

无。该变更创建全新项目，现有 OpenSpec 主规格为空，旧项目规格不在本仓库中修改。

## Impact

- 新增 React/TypeScript 前端、Node.js/TypeScript 后端、共享契约包、SQLite 状态库以及本地会话/artifact 存储。
- 新增 `@openai/codex-sdk` 与其固定 Codex CLI runtime依赖；首版不接入 App Server 双控制面。
- 迁移并适配四个 Python 3.12 Skill，保留其确定性算法、Bundle 契约、测试和真实业务夹具，不复制既有虚拟环境。
- 新增公开互联网只读策略、会话目录写边界、日志脱敏和 artifact 路径校验。
- 新增约 2.95 MB 的三流程受控 E2E fixture及小型 XLSM/CSV fixture；完整日期工作簿作为带 SHA-256 的可选验收数据。
