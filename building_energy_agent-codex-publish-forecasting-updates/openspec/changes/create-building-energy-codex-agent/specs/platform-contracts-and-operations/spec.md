## Purpose

定义浏览器与本地Node服务之间的稳定契约、事件续传、artifact安全、健康诊断和原生DGX运行要求，使系统可以被独立验证、恢复和运维。

## ADDED Requirements

### Requirement: Shared schemas are the public contract source
系统 MUST 以共享、版本化schema作为REST、SSE、持久化边界和前端类型的唯一来源，并 SHALL 从其生成OpenAPI和客户端类型。CI MUST 检测生成产物漂移。

#### Scenario: Change a public field
- **WHEN** 开发者修改公开请求、响应或事件字段
- **THEN** 生成的OpenAPI、前端类型和契约测试必须同步更新才能通过CI

#### Scenario: Generated artifact is stale
- **WHEN** 检入的OpenAPI或类型与共享schema不一致
- **THEN** 契约漂移检查失败并阻止发布

### Requirement: REST handles commands and durable resources
系统 SHALL 使用REST提供会话、消息、上传、问题回答、取消、删除、模型候选、快照、结果和artifact元数据操作。产生副作用的重试请求 MUST 支持幂等语义。

#### Scenario: Retry a message submission
- **WHEN** 客户端因网络不确定性使用相同幂等键重试消息提交
- **THEN** 系统返回同一turn而不是创建重复执行

#### Scenario: Request a missing resource
- **WHEN** 客户端请求不存在或不属于当前会话的资源
- **THEN** 系统返回结构化问题详情且不泄漏本地路径

### Requirement: SSE streams ordered resumable events
系统 SHALL 使用SSE按会话发布单调有序的业务事件，每个事件 MUST 有稳定event ID。客户端 SHALL 能以最后已接收event ID重连并补取缺失事件。

#### Scenario: Receive live events
- **WHEN** turn正在运行且SSE连接正常
- **THEN** 客户端按event ID顺序接收活动、消息和终态

#### Scenario: Reconnect after network interruption
- **WHEN** SSE连接中断后携带最后event ID重连
- **THEN** 服务端重放尚未确认的持久化事件并继续实时流

#### Scenario: No new events exist
- **WHEN** 客户端以最新event ID连接
- **THEN** 服务端保持连接用于后续事件而不重复旧事件

### Requirement: Artifact access is controlled and verifiable
系统 MUST 只通过后端生成的受控内容URL暴露artifact，并 MUST 校验会话归属、相对引用、内容类型、大小和哈希。API MUST NOT 返回绝对路径、用户控制路径、DataFrame、Parquet内容或base64大对象。

#### Scenario: Download a valid artifact
- **WHEN** 用户请求当前会话中manifest声明且哈希匹配的artifact
- **THEN** 系统以正确内容类型流式返回内容并提供安全文件名

#### Scenario: Artifact reference escapes its root
- **WHEN** manifest引用包含绝对路径、父目录跳转、软链接逃逸或不受控根
- **THEN** 系统拒绝发布和下载该artifact

#### Scenario: Artifact hash does not match
- **WHEN** 文件内容与manifest哈希不一致
- **THEN** 系统标记artifact完整性失败且不得作为正式结果提供

### Requirement: Local persistence is durable and internally consistent
系统 SHALL 使用本地持久化存储保存会话、turn、问题、事件游标和artifact索引，并 MUST 保证状态变更与可恢复事件之间不会产生已成功但无终态、已删除但仍可下载等可观察不一致。

#### Scenario: Commit a terminal turn
- **WHEN** turn进入终态
- **THEN** 状态、终态事件和结果引用以可恢复方式持久化后才向客户端确认

#### Scenario: Service stops during a state transition
- **WHEN** 进程在持久化中断
- **THEN** 重启恢复执行一致性检查并将无法证明的状态标记为interrupted

### Requirement: Health and doctor distinguish dependencies
系统 SHALL 提供轻量健康检查和详细doctor诊断。诊断 SHALL 分别报告Node服务、Codex SDK/CLI、登录、模型候选、SQLite、会话根、网络策略和各Skill环境，不得把部分就绪报告为全部可用。

#### Scenario: All dependencies are ready
- **WHEN** 所有必需组件通过检查
- **THEN** 健康状态报告ready并列出不含凭据的版本与能力摘要

#### Scenario: One Skill environment is missing
- **WHEN** Web和Codex可用但一个Skill环境未就绪
- **THEN** 健康状态明确列出该Skill不可用和恢复命令，其他能力保持真实状态

### Requirement: Logs are correlated and privacy-preserving
系统 SHALL 生成包含session、thread、turn、Skill job和correlation ID的结构化本地日志，但 MUST NOT 记录上传文件内容、隐藏推理、凭据、环境变量、绝对用户路径或完整命令输出。

#### Scenario: Diagnose a failed Skill
- **WHEN** Skill执行失败
- **THEN** 运维人员可以通过correlation ID关联请求、turn和job，同时日志只包含脱敏错误与有限上下文

#### Scenario: Potential secret appears in output
- **WHEN** 命令输出匹配凭据或敏感变量模式
- **THEN** 系统在日志与SSE持久化前替换敏感值

### Requirement: Native DGX operation is explicit
系统 SHALL 提供显式的Skill安装、开发、生产启动和doctor入口，并 SHALL 在业务运行与依赖安装之间建立硬边界。首版 MUST 可在DGX/Linux主机原生运行而不依赖Docker。

#### Scenario: Prepare a fresh development checkout
- **WHEN** 开发者执行文档化安装流程
- **THEN** 项目创建声明的Node和Python环境并验证固定入口

#### Scenario: Start the application
- **WHEN** 依赖已就绪且启动命令执行
- **THEN** 单个受控服务入口提供Web静态资源、API和SSE，并输出访问与健康地址

#### Scenario: Business request encounters missing dependency
- **WHEN** 用户turn触发未安装的Skill依赖
- **THEN** 系统失败并提供恢复说明，MUST NOT 调用安装脚本

### Requirement: Acceptance uses real and reproducible evidence
系统 MUST 提供可运行的独立Skill测试、格式fixture、三业务流、取消、问题恢复、重启恢复、模型锁定、可插拔测试Skill和浏览器验收。依赖或环境阻塞 MUST 如实报告，不得伪造通过记录。

#### Scenario: Run the standard acceptance suite
- **WHEN** 开发者在依赖就绪的受控环境执行验收入口
- **THEN** 测试使用仓库内三流程fixture和小型格式fixture验证声明的功能

#### Scenario: Run optional full-range acceptance
- **WHEN** 提供文件名和SHA-256匹配的完整日期工作簿
- **THEN** 验收运行真实完整范围并保留缺口，不依赖旧项目路径

#### Scenario: Required external condition is unavailable
- **WHEN** Codex身份、模型、浏览器或Skill依赖阻止真实验收
- **THEN** 报告明确阻塞和未验证范围，MUST NOT 生成伪造截图、图表或成功状态
