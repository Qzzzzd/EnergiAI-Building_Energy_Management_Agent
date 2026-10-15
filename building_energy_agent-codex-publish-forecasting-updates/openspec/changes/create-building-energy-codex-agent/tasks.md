## 1. 项目基础与来源基线

- [x] 1.1 初始化独立 Git 仓库与 pnpm workspace，固定 Node.js、pnpm、Python 和 Codex CLI/SDK 版本，并忽略 `.runtime/`、虚拟环境、上传文件和生成物。
- [x] 1.2 建立 `apps/web`、`apps/server`、`packages/contracts`、`.agents/skills`、`config`、`scripts`、`test-data` 与 `.runtime` 的最小目录和包边界。
- [x] 1.3 配置统一的 lint、format、typecheck、unit test、build 与 `git diff --check` 命令，并在本地 CI 脚本中逐项验证失败退出码。
- [x] 1.4 编写根 `AGENTS.md`，明确建筑能源业务边界、会话目录写权限、联网限制、禁止运行时安装依赖、禁止伪造结果以及结构化最终输出协议。
- [x] 1.5 记录旧项目来源提交 `a0d0395`、四个 Skill 的源路径与文件哈希，并清点可复制测试夹具，形成可复核的迁移清单。

## 2. 共享契约与公开协议

- [x] 2.1 在 `packages/contracts` 定义 Zod 基础类型、标识符、状态机、错误模型、`AgentTurnEnvelope` 和多问题 `needs_input` 契约。
- [x] 2.2 定义会话、消息、模型、上传、取消、删除、Skill 作业和 Artifact 的 REST 请求/响应契约。
- [x] 2.3 定义带协议版本的业务 SSE 事件判别联合，覆盖计划、活动、Skill、问题、Artifact 和全部终态。
- [x] 2.4 定义通用 Skill 生命周期命令、`BE_SKILL_EVENT` JSONL 事件、持久化作业状态和 Artifact Manifest 契约。
- [x] 2.5 从 Zod 生成 OpenAPI 与前端类型，并添加生成结果漂移检查，确保单一契约源不被手写副本绕过。
- [x] 2.6 为每类契约添加 golden、非法输入、未知版本和向后不兼容测试，验证错误均能稳定映射为公开问题详情。

## 3. 持久化与会话工作区

- [x] 3.1 建立 SQLite 迁移，包含 `sessions`、`turns`、`messages`、`question_sets`、`events`、`uploads`、`skill_jobs` 和 `artifacts`，启用 WAL 与外键。
- [x] 3.2 实现事务化仓储、幂等键、递增事件游标和终态不可逆约束，并用并发测试验证同一会话最多一个活动 Turn。
- [x] 3.3 实现会话目录管理器，仅允许写入 `.runtime/sessions/<session-id>/workspace`，并对源代码、Skill 源目录和 Artifact 路径执行边界检查。
- [x] 3.4 实现服务启动协调：恢复可续接会话，将无法确认仍在运行的 Turn/作业标记为 `interrupted`，同时保留历史事件和文件。
- [x] 3.5 实现会话删除事务，先停止活动进程再删除数据库映射和本地会话目录，并在 API/UI 中披露 Codex 主机私有线程数据不受本应用删除控制。

## 4. Codex SDK 适配层

- [x] 4.1 固定 `@openai/codex-sdk` 与兼容 Codex CLI，建立隔离的适配器接口和可产生确定性 JSONL 的假 CLI 测试夹具。
- [x] 4.2 实现新建/恢复 Codex thread、保存 thread ID、设置会话工作目录，并锁定首轮选择的模型与 reasoning effort。
- [x] 4.3 配置结构化最终输出 schema，将用户消息、只读上传引用和产品约束注入 Turn，同时拒绝未落入会话目录的路径。
- [x] 4.4 将 SDK 原始事件投影为稳定业务事件，完成去重、排序、截断、密钥/绝对路径脱敏和不可展示内容过滤。
- [x] 4.5 接入 `AbortSignal` 与进程组跟踪，先协作取消再限时强制终止，并只在实际停止后发布 `cancelled`。
- [x] 4.6 加载服务器模型 allowlist，提供模型配置校验与可选 canary 探测，并把登录失效、模型不可用和 CLI 版本不匹配暴露为可诊断健康项。
- [x] 4.7 使用真实主机 Codex 登录完成新 thread、续接 thread、结构化完成、结构化多问题和取消的适配层冒烟测试。

## 5. API 与可恢复事件流

- [x] 5.1 建立 Fastify 服务、环境配置、统一问题详情、请求关联 ID、`/health` 与 `/doctor` 基础端点。
- [x] 5.2 实现模型列表、会话 CRUD、历史读取和消息提交 REST API，并用幂等键防止重试产生重复 Turn。
- [x] 5.3 实现流式原子上传：仅接收 `.xlsx`、`.xlsm`、`.csv`，最多 10 个文件，单文件与单次请求均不超过 200 MB。
- [x] 5.4 实现问题答案提交、当前 Turn 取消和带确认的会话删除端点，验证非法状态转换返回稳定错误。
- [x] 5.5 实现先持久化后推送的 SSE，支持 `Last-Event-ID`、断线重放、心跳与慢消费者断开，确保刷新不丢事件。
- [x] 5.6 实现 Artifact 索引、受控内容下载、媒体类型与哈希响应，拒绝目录穿越、绝对路径和未登记文件。
- [x] 5.7 添加 REST/SSE 集成测试，覆盖并发提交、重连、服务重启、幂等重试、上传中断和权限边界。

## 6. 只读公网访问与安全边界

- [x] 6.1 实现每会话 Unix socket `PublicReadGateway`，只允许无请求体的 HTTP `GET`/`HEAD`，并提供受控的 `public-fetch` 命令。
- [x] 6.2 对 DNS 解析、私有/保留地址、重定向链、端口、响应大小、超时和内容类型进行逐跳校验，禁止认证头、Cookie 与用户凭据。
- [x] 6.3 将公开读取请求映射为脱敏活动事件，并确保网关返回内容只能写入当前会话工作区且可追踪来源。
- [x] 6.4 关闭 Skill/普通 shell 的直接网络，添加私网访问、数据外传、外部写操作、未知凭据和运行时安装依赖的阻断测试。
- [x] 6.5 接入 Codex Web Search 的活动投影与引用保留规则，并验证搜索结果不会绕过 Artifact 或上传数据安全边界。

## 7. 四个 Codex Skill 的迁移基础

- [x] 7.1 从来源提交复制四个 Skill 到 `.agents/skills/<skill-name>`，保留版权/来源说明，不复制 `.venv`、缓存和历史生成物。
- [x] 7.2 在改动算法前对 Skill1/Skill2 的共享 bundle、时间粒度和版本漂移建立兼容性测试，记录需要保留或显式升级的差异。
- [x] 7.3 建立可复用但不含业务编排的 `skillctl` 生命周期适配层，统一 `start/status/result/resume/cancel`、作业目录和 JSON/JSONL 输出。
- [x] 7.4 编写显式 `install-skills` 与 Skill doctor，为四个 Skill 创建固定依赖的独立 Python 3.12 环境；业务运行路径不得隐式安装依赖。
- [x] 7.5 更新每个 `SKILL.md` 与 agent metadata，使用项目内相对路径，清楚描述触发条件、输入输出、前置 bundle、失败语义和生命周期命令。
- [x] 7.6 添加一个仅由说明和脚本构成的动态测试 Skill，并证明服务器无需新增 Skill 名称分支即可发现、执行和展示它。
- [x] 7.7 分别运行四个 Skill 的独立 pytest 与跨 Skill 契约测试，确认算法结果、物理约束和失败语义均可复现。

## 8. Skill1 数据接入与格式支持

- [x] 8.1 将现有 XLSX 解析核心接入统一生命周期，生成不改变原始值的 `DatasetBundle`、来源哈希、时区和字段映射。
- [x] 8.2 增加 XLSM 安全读取：只用 `read_only`/`data_only`，不执行宏、不保留 VBA，并对缺少缓存公式值给出明确错误或提问。
- [x] 8.3 实现确定性长表 CSV 解析，仅接受 UTF-8/UTF-8 BOM、逗号分隔和 `timestamp,point_id,value_raw` 必需列。
- [x] 8.4 实现确定性宽表 CSV 解析，将首个时间列与各测点列映射为 bundle，并拒绝重复列、混合布局和不明确时间字段。
- [x] 8.5 将时区、目标测点、列映射和其他真正歧义转换为持久化作业 `needs_input`，由 Codex 汇总为同一 Turn 的多问题卡片。
- [x] 8.6 使用 XLSX、XLSM、长/宽 CSV、非法编码和接近 200 MB 边界夹具验证流式处理、无静默猜测和无原始值变换。

## 9. Skill2、Skill3 与 Skill4 业务能力

- [x] 9.1 为 Skill2 接入 24 小时处理协议，验证缺口保留、状态编码、质量门和防泄漏规则，并输出版本化 `ProcessingBundle`。
- [x] 9.2 为 Skill3 接入只读质量评估与 resume，输出 `QualityProfile`、问题维度、建议和受控可视化 Artifact。
- [x] 9.3 为 Skill4 接入评估/未来预测模式、默认 24 小时 horizon、Asia/Shanghai 语义、依赖缺失和可视化部分成功状态。
- [x] 9.4 为 Skill2/3/4 分别实现并测试 `start/status/result/resume/cancel`，确保取消能终止真实子进程且重启后状态可恢复。
- [x] 9.5 使用固定输入建立 bundle、指标、预测索引、Artifact Manifest 和文件哈希 golden 测试，检测迁移造成的算法漂移。

## 10. Web 工作台与设计系统

- [x] 10.1 建立 React/Vite 应用，落地本地字体、颜色/排版/间距 token、CSS 分层和键盘可达的基础组件。
- [x] 10.2 实现共享组件实例的三栏 `AppShell`：会话栏、对话工作区、活动检查器，并在窄屏切换为可访问 drawer，避免重复挂载状态组件。
- [x] 10.3 实现会话列表、新建会话与模型/reasoning 选择器；首轮提交后锁定选择并解释锁定原因。
- [x] 10.4 实现按 Turn 分组的消息时间线、上传队列、输入框、提交状态、错误恢复和空状态业务引导。
- [x] 10.5 实现类型安全 API 客户端、SSE reducer、游标重连和服务端历史重建，验证刷新后界面与持久化状态一致。
- [x] 10.6 实现以“负荷轨迹”为视觉母题的活动检查器，展示 todo、当前动作、Skill 进度、受控命令摘要、reasoning 摘要、模型/token、警告和错误。
- [x] 10.7 实现支持多个独立问题的 `QuestionGroup`，保存草稿、一次提交答案，并在刷新或服务重启后恢复未回答问题。
- [x] 10.8 实现运行、取消中、已取消、失败、部分成功和 interrupted 控件，确保终态与服务器事实一致且不会假装任务仍在执行。

## 11. 业务结果与 Artifact 体验

- [x] 11.1 实现通用 Artifact 浏览器，仅通过受控 `content_url` 预览/下载登记文件，并展示类型、大小、哈希、来源和生成状态。
- [x] 11.2 实现“摘要优先、技术详情折叠”的结果工作区，不在前端重新计算任何业务指标。
- [x] 11.3 实现数据质量结果视图，展示总体结论、需关注维度、问题证据、建议和相关可视化。
- [x] 11.4 实现负荷预测结果视图，展示 horizon、时间范围、核心指标、预测序列、警告和可下载 Artifact。
- [x] 11.5 为部分成功、可视化缺失和 `DEPENDENCY_MISSING` 建立诚实的降级状态，不使用占位 PNG 或虚构指标。
- [x] 11.6 完成桌面/平板/小屏响应式、焦点管理、对比度、reduced-motion、图表文本替代和数据表回退测试。

## 12. 运维、真实验收与交付门禁

- [x] 12.1 复制并校验约 2.95 MB 三流程真实夹具，生成小型 XLSM/CSV 边界夹具，并为可选全日期夹具记录 SHA-256 获取说明而不依赖旧项目路径。
- [x] 12.2 提供 `dev`、`start`、`doctor`、`install-skills` 脚本和 DGX 原生部署文档，验证全新环境准备与已安装环境启动是两个显式阶段。
- [x] 12.3 实现带关联 ID 的结构化日志、字段脱敏、大小/轮转策略和诊断导出，并用敏感样本验证日志不暴露上传内容、密钥或绝对路径。
- [x] 12.4 在真实 Codex SDK 与真实浏览器中完成数据处理→预测、数据处理→质量、综合三条工作流，核对 Turn、计划、Skill、结果和 Artifact 均到达一致终态。
- [x] 12.5 完成多问题回答、真实取消、页面刷新、SSE 重连、服务器重启恢复、interrupted 协调和模型锁定的浏览器端到端测试。
- [x] 12.6 安装动态测试 Skill 后不改服务器代码完成发现、执行、进度展示与结果查看，作为通用 Skill 架构验收门禁。
- [x] 12.7 在目标桌面、平板和小屏视口运行可访问性与浏览器测试，确认无未解释的 console error、network error、重复组件或状态丢失。
- [x] 12.8 可用时运行 SHA 校验后的全日期夹具；依赖不可用时输出 `partial`/`DEPENDENCY_MISSING` 证据，禁止把静态检查或局部成功报告为 E2E 通过。
- [x] 12.9 建立需求→测试→证据追踪矩阵；只有六份 capability spec 的所有必需场景均有可复核证据时，才允许宣告 V1 完成。
