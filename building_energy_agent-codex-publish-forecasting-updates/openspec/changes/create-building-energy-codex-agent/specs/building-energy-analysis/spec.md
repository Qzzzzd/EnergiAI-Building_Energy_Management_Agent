## Purpose

定义四个建筑能源Skills共同提供的预测、质量评估和综合分析行为，包括依赖关系、默认语义、用户歧义处理、Bundle交接以及结果必须来自确定性计算的约束。

## ADDED Requirements

### Requirement: The system supports three building-energy outcomes
系统 SHALL 支持负荷预测、数据质量评估和包含两者的综合任务。Codex SHALL 根据请求选择已安装Skills，后端 MUST NOT 使用固定任务图实现这些结果。

#### Scenario: Forecast request
- **WHEN** 用户要求基于上传数据进行负荷预测
- **THEN** Codex使用数据解析、预测数据处理和负荷预测Skill完成所需Bundle链

#### Scenario: Quality request
- **WHEN** 用户要求评估上传数据质量
- **THEN** Codex使用数据解析和质量评估Skill生成质量结果

#### Scenario: Integrated request
- **WHEN** 用户同时要求数据质量与负荷预测
- **THEN** Codex在DatasetBundle可用后可并行推进质量分支和处理/预测分支，且质量分支不是预测分支的依赖

### Requirement: Skill prerequisites are enforced through contracts
Skill2 MUST 只消费合法DatasetBundle，Skill3 MUST 只消费合法DatasetBundle，Skill4 MUST 只消费兼容ProcessingBundle。Codex MUST NOT 以自然语言、任意路径或内存DataFrame替代正式Bundle交接。

#### Scenario: Start downstream Skill with compatible Bundle
- **WHEN** 上游Bundle通过schema、版本和哈希校验
- **THEN** 下游Skill接受稳定Bundle ID并记录来源

#### Scenario: Start downstream Skill with incompatible input
- **WHEN** Bundle缺失、版本不兼容、哈希不符或类型错误
- **THEN** 下游Skill拒绝执行并返回合同错误，不得尝试猜测或修补输入

### Requirement: Forecast defaults are deterministic
预测请求在用户未覆盖时 SHALL 使用24小时预测周期和 `Asia/Shanghai` 本地时区。用户提供的合法预测周期、时区或其他已声明参数 SHALL 覆盖默认值。

#### Scenario: Use forecast defaults
- **WHEN** 用户明确目标点位但未指定预测周期和时区
- **THEN** Skill2使用24小时预测周期和 `Asia/Shanghai`，并在结果摘要中披露默认值

#### Scenario: Use valid user override
- **WHEN** 用户指定与目标时间网格兼容的预测周期和合法IANA时区
- **THEN** 系统使用用户值并记录在ProcessingBundle中

#### Scenario: Reject incompatible horizon
- **WHEN** 预测周期与目标时间网格不兼容或不是正值
- **THEN** 系统请求修正或返回验证错误，不得静默改用24小时

### Requirement: Target and semantic ambiguity requires user input
系统 MUST NOT 猜测预测目标点位、单位、时间范围、时区或质量配置。存在多个合法候选或缺少必需信息时，Codex SHALL 返回结构化 `needs_input`问题组。

#### Scenario: Multiple forecast targets exist
- **WHEN** DatasetBundle包含多个可作为目标的点位且用户未指定
- **THEN** Codex提供候选项、必要上下文和自由输入选项

#### Scenario: User answers target question
- **WHEN** 用户提交合法目标点位
- **THEN** Codex在同一thread中恢复任务并将回答传入同一逻辑执行链

### Requirement: Processing preserves leakage and gap rules
数据处理Skill MUST 构建无数据泄漏的特征、标签和时间划分，并 MUST 保留真实缺失时段。系统 MUST NOT 对目标缺口插值、拼接时间或把任意点位重新标注为固定目标语义。

#### Scenario: Source contains long gaps
- **WHEN** DatasetBundle在请求日期范围内含连续缺失时段
- **THEN** ProcessingBundle记录缺口并仅使用满足历史窗口的样本，不得伪造连续性

#### Scenario: Feature would use future information
- **WHEN** 候选特征越过对应样本的预测切点
- **THEN** Skill2拒绝该特征或整个处理请求并返回泄漏检查失败

### Requirement: Quality assessment is read-only and resumable
数据质量评估Skill MUST 只读消费DatasetBundle，生成可追溯的质量维度、问题、时间范围和报告；需要QualityProfile确认时 SHALL 保留job并在用户回答后恢复。

#### Scenario: Assess a valid DatasetBundle
- **WHEN** DatasetBundle满足质量评估前置条件
- **THEN** Skill3生成结构化质量评分、问题证据、警告和报告artifact

#### Scenario: Quality profile needs confirmation
- **WHEN** 变量角色或期望间隔存在冲突
- **THEN** Skill3进入可恢复等待状态，Codex生成问题卡且预测分支可继续独立运行

### Requirement: Forecast results are traceable
负荷预测Skill MUST 验证ProcessingBundle、泄漏规则、特征映射和分区文件，并 SHALL 输出可追溯的模型、评估或未来预测Bundle及相关可视化。

#### Scenario: Historical evaluation succeeds
- **WHEN** 合法ProcessingBundle用于回测
- **THEN** Skill4输出EvaluationBundle、指标、覆盖率、模型引用和可视化manifest

#### Scenario: Future forecast succeeds
- **WHEN** 兼容未来特征快照和模型可用
- **THEN** Skill4输出ForecastBundle并明确预测索引、目标、单位和覆盖范围

#### Scenario: Required runtime dependency is missing
- **WHEN** LightGBM、绘图库或其他声明依赖不可用
- **THEN** Skill4返回依赖缺失或部分可视化状态，MUST NOT 安装依赖或伪造图表

### Requirement: Deterministic artifacts are authoritative
所有业务数字、状态、KPI、图表和报告 MUST 来自通过schema与完整性校验的Skill artifact。Codex自然语言仅用于解释，Web MUST NOT 重算指标。

#### Scenario: Codex summarizes a result
- **WHEN** 一个结果Bundle验证成功
- **THEN** Agent回复引用artifact中的指标并能追溯到对应Bundle

#### Scenario: Agent text conflicts with artifact
- **WHEN** Codex文本与已验证artifact中的数字或状态不一致
- **THEN** Web以artifact为准并标记解释不一致，不得覆盖正式结果

### Requirement: Failed and partial results remain honest
系统 MUST 区分 `succeeded`、`partial`、`needs_input`、`failed`、`cancelled` 和 `interrupted`。系统 MUST NOT 将依赖缺失、图表缺失、取消或未完成分支展示为成功。

#### Scenario: One integrated branch fails
- **WHEN** 综合任务中的质量或预测分支失败而另一分支成功
- **THEN** 系统展示已完成分支结果并将总体状态标记为partial，保留失败原因和恢复建议
