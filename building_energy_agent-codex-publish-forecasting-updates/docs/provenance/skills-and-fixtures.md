# Skill and fixture provenance

This migration used the old repository only as a read-only source. The pinned
source commit is:

```text
repository: /home/xsh/Desktop/Agent/智能体小组
commit: a0d039569b9ef26a98128b529add0e0ead3d3e08
commit date: 2026-08-06
subject: fix: harden runtime confirmations and visualizations
```

The SHA-256 values below hash the exact `git archive <commit> <source-path>`
byte stream. They make each complete source tree independently reproducible,
including its original tests. Migration deliberately omitted `.venv`, caches,
Docker wrappers, README files, and historical runtime artifacts. The copied
algorithm modules and tests remain under the named target Skill; lifecycle,
metadata, ingestion-format, and cancellation adaptations are reviewable as new
repository changes.

| Target Skill                       | Source path at pinned commit     | Source archive SHA-256                                             |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `building-energy-data-parsing`     | `skills/data-parsing`            | `0dd241068cf9f0e8fd0ad4e125e6bf48e910e7c08b26ca0aac9b0d59b91e9db0` |
| `building-energy-data-processing`  | `skills/data-processing`         | `e24a8b534958428c51bee6940cf90403239e6eabcbac332239aa5ea921e1c744` |
| `building-energy-data-quality`     | `skills/data-quality-assessment` | `8d88be679ba24c771990900bfe40d6b7174adbea9cf94cb8194c1c4543ed6f0e` |
| `building-energy-load-forecasting` | `skills/load-forecasting`        | `88beb5f17baa822f028a71a4a2a553d2c03b6e594795713761cc0f7d394ffb0d` |

## Test fixtures

| Repository path                           | Provenance                                                                       | Size (bytes) | SHA-256                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `test-data/e2e/three-workflows-v2.xlsx`   | copied byte-for-byte from old `测试数据/建筑能源Agent三流程完整测试数据-v2.xlsx` |    2,951,705 | `dfce4a69485f64cc8348fffa6c2e3f1a6a7fceca4e01e2dcad48b697b6ba9298` |
| `test-data/formats/two-header.xlsx`       | deterministic small generated fixture                                            |        5,047 | `a1832bb3918e9f8674e01f7d90e37576bbfd42bd22f6a2bc32b242019b64e3c6` |
| `test-data/formats/formula-no-cache.xlsm` | deterministic no-cache formula fixture with inert VBA marker                     |        5,199 | `5678103c2cedb46813fb109896a90d138d2e51e8b43cc3d6dc765cbb8450607f` |
| `test-data/formats/long.csv`              | deterministic UTF-8 long-form fixture                                            |          321 | `49fb8f5083805d389e5e7957f09b42177c3d5ae22f00f6a42a2fc19d8cedfffc` |
| `test-data/formats/long-bom.csv`          | deterministic UTF-8 BOM long-form fixture                                        |          324 | `14374ea6805d50516b0e1788685661a19579bc0ff931b52a0903af684213c7ab` |
| `test-data/formats/long-aware.csv`        | deterministic offset-aware long-form fixture                                     |          158 | `407c34ad58466e6a6191820f0089f4d2ffdb3e8ee78493e789d4d7d3913576e1` |
| `test-data/formats/wide.csv`              | deterministic UTF-8 wide-form fixture                                            |          118 | `610396043abb3eb108c08b3c5282d099bb53648fbd65202b27dfa79d86d7accd` |
| `test-data/formats/duplicate-header.csv`  | invalid duplicate-column fixture                                                 |           80 | `7821d09533db6c5a886438ab955f41e2100931cd9382d290bcd86e9ae4476058` |
| `test-data/formats/ambiguous-time.csv`    | invalid ambiguous-time fixture                                                   |          110 | `c8a7fcfcf84f225721aa9454054d9aff9ef1756c827c9b16bc104b0cc08fbd3b` |
| `test-data/formats/invalid-encoding.csv`  | invalid Latin-1 fixture                                                          |           71 | `d47a4eea6d591d094efe3b787af4454a0718472701e338a9602c6e2fa163fa91` |

The optional 19,678,975-byte full-date fixture is intentionally not copied.
Operators may acquire it from the controlled fixture store and must verify
SHA-256 `4129f5b2a757ffd2ef240e161168b265989b1b6a733781c16495ad9106a26d54`
before use. Runtime tests must not depend on the old project path.

## Post-migration acceptance adaptations

The source archive hashes above identify the read-only migration inputs, not a
claim that the project Skills remained byte-identical. Project-owned lifecycle,
Artifact, cancellation, and format adaptations are covered by the Skill tests.
The shared lifecycle additionally supports an explicit `BE_SKILL_FOREGROUND=1`
mode used by `scripts/skill-run`: it executes the worker inside the active Codex
workspace-write PID namespace instead of detaching it, while retaining the same
start/status/result/resume/cancel states and events. Direct lifecycle calls keep
the original persisted-worker behavior.
The quality Skill also recognizes the deterministic synonyms used by the pinned
three-workflow fixture (`IT总功率`, `冷冻水出水温度`, `冷冻水进水温度`,
`冷机输出功率`, and `冷机运行状态`). Its regression test validates the
resulting point mappings against the same catalog schema.

Run `pnpm verify:skill-workflows` after `pnpm install:skills` to execute all
four real Skill runtimes against the 2.95 MB fixture. The command verifies the
forecast, quality, and combined topologies, validates every public Artifact
file hash, and compares stable business metrics and native bundle hashes with
`test-data/golden/three-workflows-v2.skill-workflows.json`. Raw per-run manifests
and evidence remain under `.runtime/acceptance/skill-workflows/`.
