## Purpose

定义建筑能源源文件从受控上传到不可变快照和DatasetBundle的可观察行为，覆盖XLSX、无宏执行的XLSM以及两种确定性CSV布局和大文件安全边界。

## ADDED Requirements

### Requirement: Uploads enforce supported formats and size limits
系统 SHALL 接受 `.xlsx`、`.xlsm` 和 `.csv` 文件，每条消息最多10个文件，单文件 MUST 不超过200 MB，单次上传总量 MUST 不超过200 MB。

#### Scenario: Upload supported files within limits
- **WHEN** 用户上传的文件类型、数量和总大小均合法
- **THEN** 系统接受文件并为每个文件返回稳定上传引用、名称、大小和内容哈希

#### Scenario: Reject one oversized file
- **WHEN** 任一文件超过200 MB
- **THEN** 系统在开始Skill执行前拒绝该上传并指出超限文件

#### Scenario: Reject oversized aggregate request
- **WHEN** 多文件各自合法但总大小超过200 MB
- **THEN** 系统原子拒绝该批上传且不留下可供执行的不完整快照

### Requirement: Accepted uploads become immutable session snapshots
系统 MUST 将每个被接受文件复制为当前会话拥有的不可变快照，并 SHALL 使用内容哈希、受控相对引用和原始元数据追踪来源。Skill MUST NOT 接受用户提供的任意本地路径。

#### Scenario: Register an uploaded source
- **WHEN** 上传成功完成
- **THEN** 系统为快照生成不可伪造的source reference并把源文件作为只读输入

#### Scenario: Source file changes after upload
- **WHEN** 用户机器上的同名原文件随后变化
- **THEN** 已创建快照及其哈希保持不变，任务结果仍可复现

#### Scenario: Attempt path injection
- **WHEN** 请求尝试使用绝对路径、父目录跳转或其他会话引用作为source
- **THEN** 系统拒绝请求且不读取目标路径

### Requirement: XLSX files use the approved deterministic workbook parser
系统 SHALL 以只读、内存有界的方式解析支持的XLSX工作表，保留文件、工作表、点位、原始值和时间来源；解析 MUST NOT 清洗、插值、重采样或合并不同工作表。

#### Scenario: Parse a valid workbook
- **WHEN** XLSX符合批准的双表头时序结构
- **THEN** Skill生成包含可追溯点位和UTC时间戳的DatasetBundle

#### Scenario: Workbook layout is ambiguous
- **WHEN** 时间列、点位元数据、时区或工作表布局无法确定
- **THEN** Skill返回结构化歧义，Codex生成问题卡而不是猜测映射

#### Scenario: One worksheet fails in non-strict mode
- **WHEN** 多工作表文件中一个工作表不合法且请求允许部分解析
- **THEN** DatasetBundle明确记录成功与失败工作表、警告和覆盖范围

### Requirement: XLSM parsing never executes macros
系统 SHALL 将XLSM作为只读工作簿数据处理，MUST NOT 执行或保留VBA。公式 SHALL 只读取现有缓存值；缓存缺失 MUST 作为缺失或确认条件处理。

#### Scenario: Parse an XLSM with cached formulas
- **WHEN** XLSM结构合法且公式具有缓存结果
- **THEN** 系统读取缓存值并生成与同结构XLSX一致的逻辑数据

#### Scenario: XLSM contains macros
- **WHEN** 上传的XLSM包含VBA项目
- **THEN** 系统不执行、不提取、不复制VBA，仅解析允许的数据内容

#### Scenario: Formula cache is missing
- **WHEN** 业务所需公式单元格没有缓存结果
- **THEN** 系统不得自行计算公式，并 SHALL 返回缺失警告或结构化确认需求

### Requirement: CSV supports deterministic long and wide layouts
系统 SHALL 支持UTF-8或UTF-8 BOM、逗号分隔的长表和宽表CSV。长表 MUST 提供 `timestamp`、`point_id`、`value_raw`；宽表 MUST 提供一个时间列和一个或多个以列名标识的点位值列。

#### Scenario: Parse a long-form CSV
- **WHEN** CSV包含合法的 `timestamp`、`point_id` 和 `value_raw` 列
- **THEN** 系统生成与XLSX解析结果相同逻辑模式的DatasetBundle

#### Scenario: Parse a wide-form CSV
- **WHEN** CSV包含可确定的时间列和多个点位列
- **THEN** 系统确定性展开为按timestamp和point ID组织的观测记录

#### Scenario: CSV layout is not one of the supported shapes
- **WHEN** CSV字段不能确定性匹配长表或宽表
- **THEN** 系统返回可操作的格式错误或问题卡，不允许Codex编写临时代码猜测结构

### Requirement: Time semantics are explicit
系统 MUST 将输出时间戳标准化为带时区的UTC，同时 MUST 保存源时区和转换信息。源时间为naive且无可靠时区时，系统 MUST 请求用户确认。

#### Scenario: Source has explicit timezone
- **WHEN** 源时间戳包含合法时区或请求提供合法IANA时区
- **THEN** 系统转换为UTC并在解析报告中保存源时区

#### Scenario: Naive timestamps lack timezone
- **WHEN** 源时间戳无时区且请求未提供时区
- **THEN** 系统暂停确定性解析并要求用户选择时区

### Requirement: DatasetBundle is the only successful parsing result
成功解析 MUST 生成通过schema校验的DatasetBundle和小型摘要；观测数据 MUST 保留在Bundle artifact中，不得直接嵌入Agent消息或API响应。

#### Scenario: Complete parsing succeeds
- **WHEN** 支持的源文件解析并通过Bundle验证
- **THEN** Skill返回DatasetBundle ID、摘要、警告和manifest引用

#### Scenario: Bundle validation fails
- **WHEN** 输出缺少必需字段、引用未知点位、包含非法时间或非有限编码值
- **THEN** Skill将job标记为失败且 MUST NOT 发布可供下游消费的DatasetBundle

### Requirement: Raw observations are preserved
解析Skill MUST 保留原始观测和来源血缘，不得在摄取阶段插值、修复异常、重采样、特征工程、训练模型或拼接实际缺失时段。

#### Scenario: Source contains gaps or nulls
- **WHEN** 输入数据存在连续缺失、空值或异常值
- **THEN** DatasetBundle保留这些事实并报告它们，而不是自动生成替代值
