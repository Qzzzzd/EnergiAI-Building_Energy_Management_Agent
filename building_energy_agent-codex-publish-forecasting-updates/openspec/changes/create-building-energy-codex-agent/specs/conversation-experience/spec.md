## Purpose

定义面向建筑能源业务用户的聊天优先Web体验，使长任务的Agent计划、执行、确认、取消和专业结果保持清晰可见，同时避免暴露隐藏推理和敏感实现细节。

## ADDED Requirements

### Requirement: Chat is the primary workspace
Web SHALL 将每个用户消息、Codex活动、问题、Agent回复、结果入口和任务控制组织在同一对话时间线中，MUST NOT 要求用户进入独立工作流页面才能完成任务。

#### Scenario: Complete a professional task in chat
- **WHEN** 用户上传文件并请求建筑能源分析
- **THEN** 用户可在同一对话中观察进度、回答问题、取消任务并打开结果

### Requirement: Desktop layout separates conversation and activity
桌面Web SHALL 使用会话导航、中央聊天和可折叠Agent活动三栏布局；中央聊天 MUST 保持主要视觉权重，活动栏折叠后 MUST 将空间归还聊天区。

#### Scenario: View an active task on desktop
- **WHEN** Codex正在执行长任务且活动栏展开
- **THEN** 用户同时看到聊天上下文、当前动作、任务清单和可用控制

#### Scenario: Collapse the activity panel
- **WHEN** 用户折叠右侧活动栏
- **THEN** 聊天区扩展且运行状态仍以紧凑指示保持可见

### Requirement: Agent activity is rich but sanitized
Web SHALL 展示Codex任务清单、Skill或工具、脱敏命令摘要、阶段、进度、耗时、有限输出、文件分析、reasoning summary、警告、重试、错误、模型、reasoning level和token用量。Web MUST NOT 展示隐藏思维链、凭据、绝对路径、环境变量或未经限制的完整命令输出。

#### Scenario: Command execution is running
- **WHEN** SDK发布命令执行更新
- **THEN** 时间线显示可理解的动作名称、状态和耗时，并对路径和参数脱敏

#### Scenario: Reasoning item is available
- **WHEN** SDK提供面向用户的reasoning summary
- **THEN** Web可在折叠活动项中展示摘要，但不请求或显示原始思维链

#### Scenario: Sensitive output is encountered
- **WHEN** 原始事件包含绝对路径、凭据模式或过量输出
- **THEN** 后端在持久化和传输前移除或截断敏感内容

### Requirement: Stable domain events drive the UI
前端 MUST 只依赖稳定业务事件，不得直接绑定Codex SDK原始事件联合类型。业务事件 SHALL 至少覆盖turn、计划、Skill、问题、artifact、消息和终态。

#### Scenario: SDK changes an item representation
- **WHEN** SDK升级改变内部事件字段但后端仍能投影为既有业务事件
- **THEN** 前端行为和公共契约保持兼容

#### Scenario: Unknown SDK item is received
- **WHEN** 后端收到尚未映射的SDK item
- **THEN** 系统安全记录通用活动或忽略显示，不得使当前turn崩溃

### Requirement: Needs-input responses render as question groups
当Codex最终输出 `status: needs_input`时，系统 SHALL 校验 `questions`数组并在输入区附近渲染问题组。问题数量不设硬上限，但同一组 MUST 只包含当前已经成立且相互独立的问题。

#### Scenario: Render multiple blocking questions
- **WHEN** 结构化输出包含多个合法问题、选项和自由输入规则
- **THEN** Web逐项渲染、保存草稿并在所有必填项完成后提交回答

#### Scenario: Restore unanswered questions
- **WHEN** 用户在回答前刷新浏览器或后端重启
- **THEN** 原问题组和已填草稿保持可用

#### Scenario: Structured response is invalid
- **WHEN** Codex最终输出无法通过needs-input schema校验
- **THEN** Web将内容作为普通Agent消息展示并 MUST NOT 猜测任务处于等待状态

### Requirement: Result presentation is layered
Web SHALL 在聊天中先展示结论摘要卡，并 SHALL 提供按需展开的专业结果详情，包括KPI、质量维度、预测曲线、数据覆盖、警告、可视化和文件。技术元数据 SHALL 位于折叠区。

#### Scenario: Open a quality result
- **WHEN** 用户打开质量结果详情
- **THEN** Web展示总体结论、维度评分、优先问题、证据时间范围、报告和artifact入口

#### Scenario: Open a forecast result
- **WHEN** 用户打开预测结果详情
- **THEN** Web展示评价指标、覆盖率、未来或回测曲线、特征重要性、警告和artifact入口

#### Scenario: Visualization is missing
- **WHEN** 业务Bundle成功但可视化依赖缺失
- **THEN** Web展示真实指标和明确的可视化缺失占位，不生成伪造图片

### Requirement: Conversation management is persistent and user-controlled
Web SHALL 允许用户创建、搜索、打开和删除对话。对话默认长期保留；删除 MUST 二次确认，并 SHALL 删除本地会话状态、上传文件和artifact索引。

#### Scenario: Search conversation history
- **WHEN** 用户输入历史关键词
- **THEN** Web返回匹配标题或消息摘要的本地对话

#### Scenario: Delete a conversation
- **WHEN** 用户确认删除一个非运行中对话
- **THEN** 系统移除该对话的本地记录和文件并使其不可恢复

#### Scenario: Delete an active conversation
- **WHEN** 用户尝试删除仍在运行的对话
- **THEN** 系统要求先取消实际执行并再次确认删除

### Requirement: Model selection precedes the first turn
新对话 SHALL 在首个turn前提供模型和reasoning level选择器，并 SHALL 清楚标记默认值、不可用候选和首个turn后锁定的行为。

#### Scenario: Open an empty conversation
- **WHEN** 用户尚未发送第一条消息
- **THEN** Web允许从服务端allowlist选择模型和reasoning level

#### Scenario: Reopen an established conversation
- **WHEN** 用户打开已有turn的对话
- **THEN** Web以只读方式显示该thread锁定的模型配置

### Requirement: Terminal states and controls are truthful
Web MUST 明确区分运行、等待输入、成功、部分成功、失败、取消和中断；终态项 MUST 停止动画与计时。运行中turn SHALL 提供取消入口。

#### Scenario: Turn completes
- **WHEN** 系统收到唯一的成功终态
- **THEN** Web停止运行指示并保留完成耗时和结果入口

#### Scenario: Turn is cancelled
- **WHEN** 用户取消且后端确认执行已停止
- **THEN** Web显示已取消并不再接收该turn的运行或成功更新

### Requirement: Responsive and accessible behavior is structural
Web SHALL 在桌面、平板和小屏保持可用：侧栏在窄屏变为抽屉，结果详情可全屏，卡片和图表改为单列。交互 MUST 支持键盘焦点、可见focus、Escape关闭、dialog焦点约束和reduced-motion。

#### Scenario: Use a tablet viewport
- **WHEN** 视口不足以容纳三栏
- **THEN** 活动栏变为可访问抽屉且聊天区无水平溢出

#### Scenario: Use a small viewport
- **WHEN** 左右栏均无法常驻
- **THEN** 会话与活动通过独立抽屉访问，问题卡、结果和输入区保持可操作

#### Scenario: Reduced motion is enabled
- **WHEN** 操作系统请求减少动画
- **THEN** Web禁用非必要扫描、位移和持续动画但保持状态含义
