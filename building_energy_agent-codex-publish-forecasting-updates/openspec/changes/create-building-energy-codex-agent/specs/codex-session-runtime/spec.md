## Purpose

定义单用户建筑能源 Web Agent 如何以 Codex SDK thread 作为会话运行核心，并对模型选择、沙箱、联网、取消和重启恢复提供可验证且安全的产品行为。

## ADDED Requirements

### Requirement: Web conversation maps to one Codex thread
系统 SHALL 为每个 Web 对话创建且只关联一个 Codex thread和一个隔离会话目录，并 SHALL 在该对话的后续用户消息中继续同一 thread。

#### Scenario: Start a new conversation
- **WHEN** 用户创建对话并发送第一条消息
- **THEN** 系统创建新的 Codex thread、持久化 thread ID，并将该对话的会话目录设为 Codex工作目录

#### Scenario: Continue an existing conversation
- **WHEN** 用户在已有对话中发送后续消息
- **THEN** 系统恢复该对话关联的 Codex thread，而不是创建新的上下文

### Requirement: SDK is the sole turn control plane in V1
系统 MUST 通过 TypeScript Codex SDK启动、流式运行、恢复和中止 turn，首版 MUST NOT 同时使用 App Server驱动同一 thread或 turn。

#### Scenario: Run a turn
- **WHEN** 后端接受一条可执行的用户消息
- **THEN** 后端通过 Codex SDK运行该 turn并消费结构化事件流

#### Scenario: App Server is unavailable
- **WHEN** 本机没有运行 Codex App Server
- **THEN** 首版的正常对话、进度、取消和恢复能力仍然可用

### Requirement: Model selection is allowlisted and conversation-scoped
系统 SHALL 在新对话开始前提供服务端允许的模型和 reasoning level，并 MUST 在首个 turn 开始后锁定该选择。系统 MUST NOT 接受任意模型名称。

#### Scenario: Select an allowed model
- **WHEN** 用户在空对话中选择 allowlist内的模型和 reasoning level
- **THEN** 系统使用该组合创建 Codex thread并在界面中显示已选配置

#### Scenario: Attempt to change model after first turn
- **WHEN** 用户已开始对话后尝试更换模型或 reasoning level
- **THEN** 系统拒绝原地变更并提示创建新对话

#### Scenario: Configured model is unavailable
- **WHEN** 健康检查发现 allowlist中的模型对当前 Codex身份不可用
- **THEN** 系统将该候选标记为不可选择且 MUST NOT 静默替换为其他模型

### Requirement: Conversation workspace is isolated
系统 MUST 以 `workspace-write` 沙箱运行 Codex，只允许写入当前会话目录；产品源码和 `.agents/skills` 在运行时 MUST 保持只读，其他会话目录 MUST 不可写。

#### Scenario: Write a session artifact
- **WHEN** Codex或 Skill在当前会话目录内创建临时文件或产物
- **THEN** 系统允许写入并将文件归属当前会话

#### Scenario: Attempt to modify product source
- **WHEN** Codex尝试修改 Web、后端、共享契约或 Skill源码
- **THEN** 沙箱阻止操作并向活动流发布脱敏失败状态

#### Scenario: Attempt to access another session for writing
- **WHEN** 当前对话尝试写入其他会话目录
- **THEN** 系统阻止写入且不泄漏该目录内容

### Requirement: Public internet access is read-only and observable
系统 SHALL 允许 Codex和明确需要联网的 Skill读取公开互联网信息，但 MUST 禁止上传本地数据、使用未知凭据、提交外部写操作或在运行时安装依赖。联网活动 SHALL 以脱敏摘要出现在活动时间线。

#### Scenario: Read public reference data
- **WHEN** Codex为用户任务读取公开网页或公开数据源
- **THEN** 系统允许请求并显示来源、状态和耗时的脱敏活动

#### Scenario: Attempt to upload local data
- **WHEN** Codex或 Skill尝试把上传工作簿、Bundle内容或凭据发送到外部服务
- **THEN** 系统阻止该操作并将 turn标记为需要用户可见的安全恢复

#### Scenario: Attempt to install a dependency
- **WHEN** 运行中的业务请求尝试通过网络安装 Node或Python依赖
- **THEN** 系统阻止安装并返回环境未就绪的恢复说明

### Requirement: Cancellation stops real execution
系统 SHALL 在用户取消时中止当前 Codex turn，并 SHALL 终止该 turn启动的 Skill进程或后台 Job。取消后的状态 MUST 固定为 `cancelled`，不得继续发布运行或成功状态。

#### Scenario: Cancel an active turn
- **WHEN** 用户对运行中的 turn点击取消
- **THEN** 系统中止 SDK turn、传播取消到实际 Skill执行，并发布唯一的终态事件

#### Scenario: Cancel after partial artifacts exist
- **WHEN** 取消发生前已经产生部分文件或诊断记录
- **THEN** 系统保留可审计记录但 MUST 将其标记为部分产物，且不得作为成功结果展示

#### Scenario: Continue after cancellation
- **WHEN** 用户希望在取消后继续
- **THEN** 系统要求用户明确选择继续或重试，不得自动恢复后台计算

### Requirement: Sessions survive browser and service restarts
系统 MUST 持久化聊天、thread ID、turn状态、待回答问题、事件游标和artifact索引，并 SHALL 在浏览器刷新或后端重启后恢复可恢复的对话状态。

#### Scenario: Refresh during a completed conversation
- **WHEN** 用户刷新浏览器
- **THEN** 系统恢复消息、活动终态、问题和结果入口

#### Scenario: Restart after an idle turn
- **WHEN** 后端重启且对话没有运行中的 turn
- **THEN** 系统通过已存 thread ID恢复该对话并允许继续发送消息

#### Scenario: Restart interrupts active execution
- **WHEN** 后端重启时有无法证明仍在运行的 turn或Skill Job
- **THEN** 系统将其标记为 `interrupted`并提供明确恢复动作，不得伪装为运行中或成功

### Requirement: Host Codex identity is reused without exposing credentials
系统 SHALL 使用DGX主机已有Codex CLI身份，Web MUST NOT 收集、显示或存储OpenAI API Key、登录令牌或认证文件内容。

#### Scenario: Host identity is ready
- **WHEN** Codex登录状态可用
- **THEN** 健康检查报告可运行但不返回任何凭据值

#### Scenario: Host identity is missing
- **WHEN** Codex未登录或身份失效
- **THEN** 系统拒绝开始业务 turn并显示本机恢复指引
