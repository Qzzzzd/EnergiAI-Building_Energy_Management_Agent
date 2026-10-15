## Context

参见 [proposal.md](./proposal.md) 的动机和能力清单。该仓库是全新项目，当前只有OpenSpec规划结构；旧项目 `/home/xsh/Desktop/Agent/智能体小组` 保持不变，只作为四个Skill算法基线、真实fixture和已验证交互模式的只读来源。

影响设计的当前事实与约束：

- TypeScript Codex SDK以子进程方式运行Codex CLI，支持thread start/resume、结构化流事件、每turn output schema和AbortSignal，但不提供App Server的原生 `tool/requestUserInput` 或动态 `model/list`。
- 产品运行在DGX/Linux的单用户环境，复用主机现有Codex身份；不需要应用账号或多租户隔离。
- 现有四个Skill包含可复用的确定性Python算法，但Skill1/2的Codex说明不完整且共享源码已发生漂移；Skill3/4已有较成熟的独立CLI和Skill结构。
- 长任务、真实取消、浏览器/服务重启恢复、artifact安全和诚实的partial/依赖缺失状态是不可降级的产品要求。
- 后端必须对具体Skill零认知；未来安装符合约定的Skill不得要求新增业务分支。

## Goals / Non-Goals

**Goals:**

- 用单一Codex SDK控制面实现可恢复thread、流式活动和自主Skill编排。
- 把模型自主性限制在会话workspace、已安装Skills和可审计的公开只读网络边界内。
- 为计算型Skill定义足够小但完整的通用lifecycle、事件和artifact协议。
- 提供聊天优先、过程丰富、结果可信且适合建筑能源业务人员的中文Web体验。
- 让公共契约、持久化状态、SSE事件和前端类型共享同一schema来源。
- 在旧项目完全不变的前提下逐层迁移和验收四个Skill。

**Non-Goals:**

- 不复制旧FastAPI、OpenAI Agents SDK Runtime、固定任务图或旧OpenAPI。
- 不提供多用户、租户、云队列、分布式Worker或定时任务。
- 不在首版同时使用Codex SDK与App Server。
- 不允许Web安装未知Skill、连接市场或修改产品/Skill源码。
- 不支持任意CSV猜测、宏执行、业务请求内依赖安装或对外数据写入。
- 不提供通用Coding Agent工作台，也不把完整终端暴露给用户。

## Decisions

### 1. 使用pnpm TypeScript monorepo和原生Python Skill目录

计划结构：

```text
building-energy-codex/
├── apps/
│   ├── web/                    # React + Vite
│   └── server/                 # Node.js + Fastify
├── packages/
│   └── contracts/              # Zod、事件、OpenAPI生成
├── .agents/
│   └── skills/
│       ├── building-energy-data-parsing/
│       ├── building-energy-data-processing/
│       ├── building-energy-data-quality/
│       └── building-energy-load-forecasting/
├── .runtime/                   # gitignored
│   ├── app.db
│   ├── sessions/<session-id>/
│   ├── skill-envs/<skill-name>/
│   └── logs/
├── test-data/
│   ├── e2e/
│   ├── formats/
│   └── optional/
├── scripts/
└── openspec/
```

选择Fastify而不是复用FastAPI，是为了让Codex SDK、SSE投影、Zod契约和前端类型留在同一TypeScript运行时；Python只承担确定性业务计算。首版保持一个Node进程和一个SQLite文件，不引入Redis或消息队列。

替代方案：继续用FastAPI并接Python Codex SDK。未采用，因为Python SDK仍处于beta且会保留两套应用语言边界；旧FastAPI也容易把固定orchestrator重新带入新项目。

### 2. 每个Web对话对应一个Codex thread

`SessionRuntime` 保存 `session_id → codex_thread_id → workspace_path` 的一对一映射。首个turn通过SDK `startThread()`创建，事件流中获得thread ID后立即事务性保存；后续turn通过 `resumeThread()`恢复。

每次SDK调用均设置：

- `workingDirectory`：`.runtime/sessions/<session-id>/workspace`
- `sandboxMode`：`workspace-write`
- `approvalPolicy`：`never`
- `model`和`modelReasoningEffort`：来自会话锁定配置
- `networkAccessEnabled`：`false`，直接Shell外网由只读网络代理取代
- `AbortSignal`：绑定当前turn的取消控制器

虽然SDK每turn启动一个CLI子进程，thread上下文由Codex持久化；Node后端不维护长驻CLI终端。后端只允许同一session同时存在一个active turn，使用数据库唯一约束和进程内互斥防止重复提交。

替代方案：一个长驻App Server连接承载所有thread。未采用，因为原生问题请求和model catalog不足以抵消第二控制面的协议、版本和恢复成本。

### 3. 使用仓库AGENTS.md约束Agent，使用每turn output schema约束终态

仓库根 `AGENTS.md` 将成为运行中的产品级Agent规则，声明：

- 主题是建筑能源业务，而非代码开发；
- 必须优先使用已安装Skills及其前置条件；
- 禁止修改项目源码、安装依赖、猜测业务参数或伪造结果；
- 只能在当前会话目录处理用户文件；
- 多个确认问题只包含当前已成立、相互独立的决策；
- 正式业务数字只能引用验证通过的artifact。

后端为每个turn传入统一 `AgentTurnEnvelope` JSON Schema：

```ts
type AgentTurnEnvelope =
  | {
      status: "completed" | "partial";
      message: string;
      result_refs: ArtifactRef[];
    }
  | {
      status: "needs_input";
      message?: string;
      questions: Array<{
        id: string;
        question: string;
        options: string[];
        allow_free_text: boolean;
        required: boolean;
      }>;
    };
```

SDK级 `turn.failed`、AbortError和进程退出不伪装成上述业务终态，而由运行时映射为 `failed`、`cancelled` 或 `interrupted`。

上传文件不会作为任意绝对路径拼进用户文本。后端在实际Codex输入中增加机器生成的相对source refs、当前会话信息和允许的恢复上下文，同时UI保留用户原始消息。

### 4. 模型选择使用配置allowlist并在首turn后锁定

`config/models.yaml`（具体格式由共享schema校验）声明可见模型、display name、允许的reasoning levels和默认值。Web只读取后端返回的已验证候选。

由于TypeScript SDK没有 `model/list`，运行时不依赖隐藏或实验性catalog接口。启动健康检查验证配置结构、Codex CLI可执行性和默认模型；`doctor --probe-models`以短超时、只读、无工具副作用的canary turn探测每个候选并缓存结果。探测失败的候选在Web中禁用，绝不自动替换模型。

模型与reasoning在首个turn提交事务中写入session；之后API拒绝修改。这样恢复时可以用同一ThreadOptions重建SDK Thread对象。

### 5. 原始SDK事件先持久化投影，再通过SSE发布

后端不把SDK联合类型直接公开。`CodexEventProjector`将原始事件投影为版本化业务事件：

```text
turn.started
plan.updated
agent.activity
skill.started
skill.progress
skill.completed
input.required
artifact.created
assistant.message
turn.completed
turn.partial
turn.failed
turn.cancelled
turn.interrupted
```

映射原则：

| SDK/Skill来源 | 业务投影 |
| --- | --- |
| `thread.started` | 保存thread ID，不直接暴露内部路径 |
| `turn.started` | `turn.started` |
| `todo_list` | `plan.updated` |
| `agent_message` / reasoning summary | 脱敏后的 `agent.activity` 或 `assistant.message` |
| `command_execution` | 通用活动；识别Skill envelope后投影为Skill事件 |
| `file_change` | 会话文件活动，不等同正式artifact |
| `mcp_tool_call` / `web_search` | 脱敏工具或联网活动 |
| `turn.completed` | 只有终态envelope和artifact校验完成后发布业务终态 |
| `turn.failed` / stream error | `turn.failed` |

每个业务事件在SQLite事务中分配单调递增的session-local `event_id`，先提交数据库再推送SSE。重连使用 `Last-Event-ID` 或 `after_event_id`重放；实时订阅只传数据库已提交事件。

原始命令输出只在内存中做增量解析，不整体持久化。活动摘要通过路径归一化、凭据模式遮盖、行数与字节上限后才能落库。

### 6. 计算型Skill采用通用lifecycle与JSONL envelope

每个计算型Skill提供同形入口，例如：

```text
scripts/skillctl start  --request <json-file>
scripts/skillctl status --job-id <id>
scripts/skillctl result --job-id <id>
scripts/skillctl resume --job-id <id> --answers <json-file>
scripts/skillctl cancel --job-id <id>
```

通用事件最小结构：

```json
{
  "protocol_version": "1.0",
  "event_id": "...",
  "skill_name": "...",
  "job_id": "...",
  "kind": "started|progress|needs_input|artifact|completed|failed|cancelled",
  "stage": "...",
  "progress": { "completed": 1, "total": 4, "unit": "stage" },
  "warnings": [],
  "payload": {}
}
```

JSONL行使用固定前缀（例如 `BE_SKILL_EVENT `）与普通日志分离。Projector按SDK command item ID记录已消费字节偏移，避免SDK的聚合输出更新导致重复事件。job状态还必须由Skill持久化在当前会话目录，stdout不是唯一事实源。

后端不解析具体Skill payload，只校验通用字段并注册artifact manifest。instruction-only Skill无需skillctl；它们使用普通Codex活动呈现。

迁移四个Skill时，wrapper调用原算法入口而不重写计算：

- Skill1：补齐XLSX/XLSM/CSV解析与Codex指令；
- Skill2：以当前24h `building-energy-history-v2`实现为准，解决与Skill1共享代码漂移；
- Skill3：保留start/status/resume/result与QualityProfile确认；
- Skill4：保留历史评价、未来预测、持久job和依赖缺失语义。

### 7. Bundle和artifact使用版本化manifest与受控根

正式Bundle继续使用：

```text
DatasetBundle → ProcessingBundle → Model/Evaluation/ForecastBundle
       └──────→ QualityResultBundle
```

通用artifact manifest只描述小型元数据：

```ts
type ArtifactManifest = {
  schema_version: string;
  artifact_id: string;
  artifact_type: string;
  producer: { skill_name: string; job_id: string };
  source_ids: string[];
  status: "succeeded" | "partial";
  files: Array<{
    relative_path: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
    role: string;
  }>;
  summary: Record<string, unknown>;
  warnings: string[];
};
```

Artifact service以session artifact root为唯一解析起点，使用真实路径检查防止 `..`、绝对路径和软链接逃逸；下载前验证归属、大小、哈希和媒体类型。Parquet、DataFrame和原始大型JSON不进入公共响应。未知 `artifact_type` 使用通用文件详情，已知建筑能源类型由前端注册的纯展示组件增强，后端仍不按Skill分支。

### 8. 摄取层为XLSX/XLSM/CSV提供确定性适配器

上传端采用流式multipart写入临时文件，同时计算SHA-256和累计字节；只有整批通过数量、单文件和总量校验后，才原子移动到session `inputs/`。文件扩展名、MIME和magic bytes需要一致；失败批次不注册source refs。

Skill1内部按格式路由到确定性parser：

- XLSX/XLSM：复用行流式openpyxl实现，`read_only=True`、`data_only=True`、`keep_links=False`；XLSM不加载或保留VBA。
- 长表CSV：严格识别 `timestamp`、`point_id`、`value_raw`，允许声明的可选元数据列。
- 宽表CSV：确定时间列后，将其他数值/状态列的列名作为稳定point ID；无法唯一确定时间列时返回歧义。
- CSV只接受UTF-8/UTF-8 BOM与逗号；首版不自动探测任意编码或分隔符。

三个parser最终写入相同DatasetBundle schema和parse report。不同文件、工作表默认独立，Skill1不在摄取阶段合并、清洗、插值或重采样。

### 9. 网络采用只读出口代理，而不是开放Shell网络

仅靠Agent指令无法强制“允许GET但禁止POST”。因此Codex sandbox保持直接网络关闭，并提供两条受控读取路径：

1. Codex内建Web Search，用于公开网页检索并产生可观察search事件；
2. Node `PublicReadGateway`，只允许 `GET`/`HEAD`，拒绝请求体、Cookie、Authorization、私网/loopback/link-local地址和重定向到非公开地址，并限制响应大小、类型、重定向次数和超时。

Skill或Codex通过项目提供的 `public-fetch` CLI与当前session内的Unix socket调用gateway；CLI不能访问任意网络。gateway对DNS解析前后均执行私网检查，所有请求记录脱敏URL、来源类型、状态、大小和耗时，不记录响应正文。

这比 `networkAccessEnabled: true` 更复杂，但能实际满足“公开互联网只读”和“禁止数据外传”。未来需要认证天气API或外部写操作时必须另开能力规格。

### 10. REST、SSE和共享Zod契约

建议资源边界：

```text
GET    /api/v1/health
GET    /api/v1/doctor
GET    /api/v1/models
GET    /api/v1/sessions
POST   /api/v1/sessions
GET    /api/v1/sessions/:sessionId
DELETE /api/v1/sessions/:sessionId
POST   /api/v1/sessions/:sessionId/uploads
POST   /api/v1/sessions/:sessionId/messages
POST   /api/v1/sessions/:sessionId/cancel
GET    /api/v1/sessions/:sessionId/events
GET    /api/v1/sessions/:sessionId/artifacts
GET    /api/v1/artifacts/:artifactId/content
```

回答问题仍通过messages端点，payload引用question IDs；不增加另一种turn控制机制。消息、上传、取消和删除接受idempotency key。错误采用共享Problem Details schema，包含稳定code、用户可读说明、correlation ID和恢复动作，不含绝对路径。

`packages/contracts`拥有Zod schemas、事件版本和OpenAPI生成入口。server routes与web client均从该包导入类型；生成的OpenAPI作为可审阅artifact检入，但不是第二手写来源。

### 11. SQLite状态机和进程恢复

最小数据表：

```text
sessions       id, title, thread_id, model, reasoning, status, workspace, timestamps
turns          id, session_id, idempotency_key, status, started_at, finished_at, error
messages       id, session_id, turn_id, role, content, created_at
question_sets  id, session_id, turn_id, schema_json, draft_json, status
events         session_id, event_id, turn_id, type, payload_json, created_at
uploads        id, session_id, source_ref, relative_path, size, sha256, media_type
skill_jobs     id, session_id, turn_id, skill_name, external_job_id, status, metadata_json
artifacts      id, session_id, turn_id, manifest_path, type, status, sha256
```

数据库启用WAL、foreign keys和事务。终态事件、turn状态和artifact索引在一个事务内提交。Node进程内保存active turn的AbortController、SDK child关联和Skill进程组；启动时扫描数据库与Skill job状态文件：能证明终态则调和，无法证明继续运行的一律标记 `interrupted`。

每个Skill启动器创建独立进程组。取消先发合作式cancel，再在限定时间后终止进程组，最终核对Skill持久状态。只有实际停止得到确认后才发布 `turn.cancelled`。

删除会话先阻止新turn，取消active执行，删除数据库关联和 `.runtime/sessions/<id>`。SDK拥有的主机Codex session文件不通过未公开文件格式直接删除；应用删除thread映射后不再提供恢复入口，并在隐私说明中披露主机Codex自身的留存边界。

### 12. 前端按shell、session、conversation、activity和result拆分

旧项目值得继承的是“聊天内闭环、真实状态、确认靠近输入、结果按需深入和响应式抽屉”，而不是其大型 `App.tsx`、重复桌面/抽屉实例、固定三流程菜单和单文件CSS。

建议组件边界：

```text
AppShell
├── SessionRail
├── ConversationWorkspace
│   ├── ConversationTimeline
│   │   └── TurnBlock
│   ├── QuestionGroupCard
│   ├── ResultSummaryCard
│   └── Composer
├── ActivityInspector
│   ├── LiveStatus
│   ├── TodoTimeline
│   └── ActivityItem
└── ResultWorkspace
    ├── ResultOverview
    ├── QualityResult
    ├── ForecastResult
    └── ArtifactBrowser
```

状态由session store按规范化实体维护，桌面栏和移动抽屉复用同一内容组件和状态，不渲染两套独立实例。SSE reducer只消费业务事件；Result组件只消费验证后的manifest DTO。

### 13. 视觉系统以“可验证的负荷轨迹”为主题

具体受众是需要等待并信任长计算的楼宇能源工程师；页面唯一主任务是“在一次对话中看清Agent正在做什么，并判断结果是否可信”。设计不使用通用AI渐变、终端黑绿风或暖米色杂志模板。

第一版视觉tokens：

| 角色 | 名称 | 色值 | 用途 |
| --- | --- | --- | --- |
| canvas | 设备雾白 | `#F3F7F6` | 页面底色 |
| surface | 仪表白 | `#FFFFFF` | 对话、卡片、抽屉 |
| ink | 碳墨 | `#17231F` | 主文本与高对比结构 |
| primary | 冷凝水蓝 | `#2F718E` | 主操作、活动轨迹 |
| success | 校验青 | `#167A68` | 成功与可信结果 |
| attention | 负荷琥珀 | `#C9822B` | 等待、partial、关注 |
| danger | 告警朱红 | `#BE4A3B` | 失败、取消、风险 |
| line | 管网灰 | `#CBD8D3` | 分隔线和静态轨道 |

字体采用本地打包的 `Noto Sans SC` 作为中文正文与控件、`IBM Plex Sans Condensed` 作为少量英文阶段标签、`IBM Plex Mono` 作为指标、时间和哈希。若无法合法打包字体，构建必须使用声明的系统fallback并保持度量测试，不在运行时依赖外部字体CDN。

标志性元素是右侧活动栏的“负荷轨迹”：任务节点沿一条类似时序负荷曲线的细轨道排列，轨道同时编码计划顺序、并行分支和当前动作；它是业务真实信息而非装饰。只在当前动作使用一次克制的脉冲，reduced-motion下改为静态高对比标记。

布局保持线性、低圆角、精确网格和清晰分隔，避免每段内容都套大圆角卡。结果图表沿用同一语义颜色，但指标颜色不作为唯一状态信号。

### 14. 响应式与可访问性在组件设计时完成

- 宽桌面：三栏常驻，中栏弹性，活动栏可折叠。
- 中等视口：活动栏变右侧抽屉，SessionRail可保持窄栏。
- 小屏：左右均为抽屉，结果详情全屏，KPI、问题和文件列表单列。
- dialog/drawer使用单一挂载实例、焦点约束、返回焦点和Escape关闭。
- 所有状态有文本与图形双重编码；图表提供摘要、数据表或可下载数据。
- 活动更新使用polite live region，终态/错误使用适度优先级，避免每个进度tick都打断读屏。
- 动画遵守 `prefers-reduced-motion`，键盘focus必须清晰可见。

### 15. 原生安装、启动与诊断

项目固定Node与Python版本并检入lockfiles。脚本职责：

```text
scripts/install-skills  显式创建四个Skill环境并验证入口
scripts/dev             启动server与Vite开发服务，检查端口
scripts/start           启动生产Node服务并提供已构建前端
scripts/doctor          检查Codex、模型、SQLite、目录、网络代理和Skills
```

生产Node服务托管前端静态文件、REST和SSE。服务启动不安装任何依赖；Skill环境缺失只影响对应能力并在health中精确报告。日志写入 `.runtime/logs`，默认滚动和大小上限在部署配置中声明。

### 16. 测试按合同、适配器、真实运行和浏览器分层

- `packages/contracts`：Zod/OpenAPI快照、兼容与负面用例。
- server unit：状态机、事件投影、脱敏、路径/哈希、幂等、SSE重放。
- SDK adapter integration：使用可控fake CLI验证事件/Abort，再用真实Codex身份做受控smoke。
- Skill pytest：每个Skill独立环境运行自身tests。
- cross-Skill：DatasetBundle→Skill3、DatasetBundle→ProcessingBundle→Skill4的物理加载与schema/hash门禁。
- formats：XLSX、XLSM缓存公式、宏忽略、长表CSV、宽表CSV、200 MB边界的流式/限制测试。
- real workflows：仓库内约2.95 MB fixture执行预测、质量和综合任务；可选19.7 MB fixture按SHA-256启用完整日期验收。
- browser E2E：模型锁定、多问题组、活动时间线、取消、刷新、服务重启、结果详情、artifact下载、响应式和可访问性。
- extensibility：安装一个测试Skill，证明后端无改动即可被Codex发现，符合协议时获得高级UI，不符合时安全退化。

真实模型、浏览器或依赖不可用时，测试报告必须标记未验证层，禁止以mock、静态截图或伪造PNG替代真实验收结论。

## Risks / Trade-offs

- **[Codex SDK事件和CLI行为随版本变化]** → 固定SDK/CLI版本、通过adapter隔离、保存golden事件fixture，并在升级PR中运行真实smoke与契约差异检查。
- **[SDK没有原生request-user-input]** → 统一每turn output schema，以完成turn后的问题组实现确认；若未来必须中途请求，再单独评估App Server，不混用控制面。
- **[SDK没有动态model list]** → 使用显式allowlist和可选canary探测；Web不显示未经验证的任意模型。
- **[Codex自主编排可能漏掉前置Skill或错误重试]** → 把依赖和禁止项写入SKILL.md与AGENTS.md，同时由下游Bundle schema、版本和哈希硬拒绝错误输入。
- **[通过命令输出识别Skill事件可能受聚合更新影响]** → 使用固定前缀、event ID、字节偏移和Skill持久job状态去重；stdout只作通知，不作唯一事实源。
- **[200 MB上传和工作簿解析消耗资源]** → multipart流式落盘、累计限额、openpyxl read-only、CSV批处理、磁盘余量检查和进程资源上限。
- **[只读互联网难以靠提示强制]** → 关闭直接Shell网络，以Unix socket只读gateway和Web Search提供读取能力；拒绝正文上传、私网地址、凭据和写方法。
- **[取消CLI父进程不一定终止所有Python子进程]** → Skill启动器使用进程组、合作式cancel、超时强制终止和状态核验，只有真实停止后发布cancelled。
- **[SQLite单进程限制未来扩展]** → V1明确单用户单Node实例；存储接口与业务schema分离，但不提前引入分布式组件。
- **[主机Codex session文件不受应用删除API控制]** → 删除应用映射和会话workspace，披露主机Codex留存；不直接修改SDK私有存储格式。
- **[参考旧UI可能重新引入单体结构]** → 只继承用户路径和状态语义，按明确组件边界、单一状态实例和CSS layers重新实现。
- **[四个Skill迁移基线存在Skill1/2源码漂移]** → 从提交 `a0d0395` 分别提取各Skill真实入口，先冻结兼容测试，再决定共享contracts/core的唯一版本，禁止任选一份覆盖另一份。

## Migration Plan

1. 在新仓库建立pnpm workspace、共享schema、CI和仅含健康/静态页面的最小可运行骨架；旧项目继续服务，作为回退路径。
2. 从旧提交 `a0d0395` 复制四个Skill源码和受控fixture，不复制环境；记录来源commit、路径清单和内容哈希。
3. 先修复Skill1/2共享合同基线并为四个Skill增加通用lifecycle/manifest适配，保持独立pytest与跨Skill门禁通过。
4. 实现SQLite、上传、artifact、事件投影、Codex SDK adapter、沙箱和只读网络gateway，并用fake CLI与真实Codex smoke验证。
5. 实现从聊天、问题组到活动时间线和结果详情的Web垂直切片，再补会话管理、响应式和可访问性。
6. 运行格式、三真实流程、取消、刷新/重启、模型锁定、动态测试Skill和浏览器分层验收；只在所有必需层有真实证据时宣布V1完成。
7. 切换仅通过启动入口和访问地址完成；若新系统验收失败，停止新服务并继续使用未修改的旧项目。新项目不写旧数据，因此无需数据回滚。
