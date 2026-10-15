## Purpose

定义Codex如何从仓库自动发现并执行可扩展Skills，以及计算型Skill如何通过统一生命周期和产物约定接入Web活动、恢复与结果展示而无需后端专用代码。

## ADDED Requirements

### Requirement: Skills are discovered from the repository
系统 SHALL 允许Codex从仓库级 `.agents/skills/<skill-name>/SKILL.md`发现Skill，后端 MUST NOT 维护具体Skill名称白名单、固定业务Registry或按Skill分支的执行代码。

#### Scenario: Install a conforming Skill
- **WHEN** 开发者将一个合法Skill目录安装到 `.agents/skills`
- **THEN** Codex可以依据该Skill的名称和描述选择它，而无需修改后端源码

#### Scenario: Remove a Skill
- **WHEN** 一个Skill从安装目录移除
- **THEN** 新turn不再向Codex声明该Skill，既有历史记录仍保持可读

### Requirement: Codex owns Skill selection and sequencing
系统 SHALL 由Codex依据用户请求、Skill描述、前置条件和产物契约制定执行计划、选择Skill并安排顺序或并行；后端 MUST NOT 冻结建筑能源任务图。

#### Scenario: Select Skills for a forecast request
- **WHEN** 用户提出需要解析、处理和预测的请求
- **THEN** Codex依据已安装Skill的前置关系安排所需步骤，后端仅运行和记录通用事件

#### Scenario: Add a new compatible Skill
- **WHEN** 新Skill声明可消费现有Bundle或生成新的artifact
- **THEN** Codex能够在合适任务中选择该Skill且后端无需新增流程节点

### Requirement: Compute Skills expose a common lifecycle
需要长计算、恢复、取消或结构化业务结果的Skill MUST 提供机器可读的 `start`、`status`、`result`、`resume` 和 `cancel` 操作，并 SHALL 使用统一状态和错误envelope。

#### Scenario: Start and monitor a compute Skill
- **WHEN** Codex启动计算型Skill
- **THEN** Skill返回job ID和状态，并通过 `status` 提供阶段、进度、警告和终态

#### Scenario: Resume a paused Skill
- **WHEN** Skill在获得用户答案后可以继续
- **THEN** Codex使用稳定job ID和结构化回答调用 `resume`，而不是创建不相关的新job

#### Scenario: Cancel a Skill job
- **WHEN** 系统传播用户取消
- **THEN** Skill的 `cancel` 使job进入不可逆取消终态并停止实际计算

### Requirement: Skill output is machine-readable and streamable
计算型Skill MUST 以JSON或JSONL输出生命周期、进度、警告、错误和结果引用；系统 MUST NOT 依赖自由文本猜测Skill状态。

#### Scenario: Publish progress
- **WHEN** Skill完成一个可观察阶段
- **THEN** Skill输出包含job ID、stage、progress和timestamp的合法事件

#### Scenario: Emit malformed output
- **WHEN** Skill输出无法通过通用envelope校验
- **THEN** 系统将该执行标记为协议失败并展示恢复说明，不得猜测成功或继续下游步骤

### Requirement: Instruction-only Skills remain supported
不产生长任务或业务artifact的instruction-only Skill MAY 不实现计算生命周期，系统 SHALL 仍允许Codex使用它并通过通用Agent活动展示执行情况。

#### Scenario: Use an instruction-only Skill
- **WHEN** Codex选择一个仅包含说明或短脚本的Skill
- **THEN** 系统运行该Skill且不要求伪造job或Bundle

### Requirement: Advanced UI depends on generic contracts, not Skill identity
系统 SHALL 根据通用lifecycle事件和artifact manifest提供进度、恢复和结果卡；对于不采用这些约定的新Skill，系统 SHALL 退化为通用命令、消息和文件展示。

#### Scenario: Conforming compute Skill produces a result
- **WHEN** 新Skill输出合法lifecycle事件和artifact manifest
- **THEN** Web展示结构化进度和结果入口，无需识别该Skill名称

#### Scenario: Unknown artifact type is produced
- **WHEN** 新Skill生成合法但未定义专用结果视图的artifact类型
- **THEN** Web提供通用元数据、预览或下载入口且后端不失败

### Requirement: Skill environments are explicit and immutable during requests
每个Python计算型Skill MUST 使用项目管理的独立环境，业务turn MUST NOT 自动创建环境、安装依赖或修改Skill源码。

#### Scenario: Skill environment is ready
- **WHEN** doctor检查确认Skill入口和依赖可用
- **THEN** Codex可以调用该Skill的固定入口

#### Scenario: Skill environment is missing a dependency
- **WHEN** Skill入口或声明依赖不可用
- **THEN** 系统返回环境未就绪错误和显式安装指引，且不在该turn中执行安装

### Requirement: The four migrated Skills retain deterministic behavior
迁移后的数据解析、数据处理、数据质量评估和负荷预测Skill MUST 保留其已验证的确定性算法与Bundle边界，并 MUST 通过迁移前后兼容性测试证明结果未被Codex适配层重算或替代。

#### Scenario: Run a migrated Skill fixture
- **WHEN** 对同一受控fixture运行迁移后的Skill
- **THEN** 其合同字段、关键业务指标和artifact哈希满足已定义的兼容性断言

#### Scenario: Codex explains a Skill result
- **WHEN** Skill返回验证通过的结果
- **THEN** Codex可以解释结果但 MUST NOT 改写原始指标、状态或Bundle内容
