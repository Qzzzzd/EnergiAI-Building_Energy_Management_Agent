# V1 requirement, test, and evidence traceability

This matrix covers every required scenario in the six capability specs. A row
groups only the scenarios belonging to the named requirement. `automated`
means the cited suite asserts the behavior; `real` means the cited command uses
the host Codex login and/or Chromium rather than a fake adapter. Runtime
evidence is intentionally kept below `.runtime/acceptance/` and is not a source
artifact.

## Phase seven verification snapshot (2026-08-12)

The phase-seven shell acceptance run passed 6 browser tests, including the
compact model menu, refresh/SSE retry, responsive drawers, and explicit
screenshots at 1440, 1200, 1080, and 760 pixels. The saved shell evidence is
`.runtime/acceptance/browser/phase7-responsive-shell.json`; its browser error
arrays are empty.

The required `integrated-parallel` real-browser run was attempted with
`BE_E2E_BASE_URL=http://127.0.0.1:8788` and
`BE_E2E_RUN_WORKFLOWS=true`. It is recorded as `DEPENDENCY_MISSING`, not a
pass: `scripts/doctor` reports `codex-sandbox` unavailable because AppArmor
blocks unprivileged user namespaces. The saved evidence is
`.runtime/acceptance/browser/workflow-integrated-parallel.json`, with the
dependency-state screenshots named in that file. No TaskPlan or result-detail
success is claimed from those screenshots.

## Previously recorded acceptance evidence

Earlier clean runs produced the following machine-readable evidence:

- `.runtime/acceptance/browser/workflow-processing-to-forecast.json` — Chromium workflow passed; Session `idle`, Turn `completed`, all expected Skill jobs and Artifacts `succeeded`, browser problem arrays empty.
- `.runtime/acceptance/browser/workflow-processing-to-quality.json` — Chromium quality workflow passed with the same terminal and browser checks.
- `.runtime/acceptance/browser/workflow-integrated-parallel.json` — the earlier 2026-08-10 combined-workflow pass was superseded by the phase-seven `DEPENDENCY_MISSING` record above; rerun only after the sandbox is ready.
- `.runtime/acceptance/browser/dynamic-skill.json` — newly installed `building-energy-dynamic-proof` discovered and executed without a backend Skill-name branch.
- `.runtime/acceptance/browser/real-skill-cancellation.json` — real parsing Skill observed running, then Turn reached `cancelled`; browser problem arrays empty.
- `.runtime/acceptance/skill-workflows/run-20260810T060417Z/evidence.json` — independent cross-Skill topologies passed with `golden_verified: true` and seven public Artifacts.
- `.runtime/smoke/evidence/real-codex-latest.json` — SDK/CLI `0.147.0`, `gpt-5.6-sol`/`xhigh`, new/resume thread, structured two-question output, and AbortSignal checks passed.

The full-date optional fixture remains honestly `partial`: its controlled
19,678,975-byte source is unavailable locally, while the copied 2,951,705-byte
three-workflow fixture is SHA-256 verified in the provenance record.

## Building-energy analysis

| Requirement                 | Scenarios covered                                     | Test and evidence                                                                                                           |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Three outcomes              | Forecast request; Quality request; Integrated request | `pnpm verify:skill-workflows`; real Chromium `BE_E2E_RUN_WORKFLOWS=true` cases in `apps/web/e2e/real-service.acceptance.ts` |
| Skill prerequisites         | Compatible Bundle; incompatible input                 | Four Skill pytest suites; `tests/skills/test_public_artifact_bridge.py`                                                     |
| Forecast defaults           | Defaults; valid override; incompatible horizon        | processing and forecasting pytest suites; workflow golden                                                                   |
| Target ambiguity            | Multiple targets; answer target question              | Skill1/2 pytest plus multi-question browser harness                                                                         |
| Leakage and gaps            | Long gaps; future-information feature                 | processing pytest and `test-data/golden/three-workflows-v2.skill-workflows.json`                                            |
| Read-only resumable quality | Valid assessment; profile confirmation                | quality pytest; common lifecycle foreground resume test                                                                     |
| Traceable forecast          | Evaluation; future forecast; missing dependency       | forecasting pytest; Skill doctor; real forecast browser case                                                                |
| Authoritative artifacts     | Codex summary; conflicting Agent text                 | Artifact registration/hash integration tests and real workflow API assertions                                               |
| Honest partial failure      | One integrated branch fails                           | server/runtime tests and frontend partial-state unit tests                                                                  |

## Building-energy data ingestion

| Requirement            | Scenarios covered                                          | Test and evidence                                                                      |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Format and size limits | Supported upload; oversized file; oversized aggregate      | `apps/server/test/api.test.ts`; near-boundary deterministic generator test             |
| Immutable snapshots    | Register source; source changes; path injection            | upload/API integration and workspace-boundary tests                                    |
| XLSX parser            | Valid workbook; ambiguous layout; non-strict sheet failure | parsing pytest and `tests/skills/test_data_ingestion_formats.py`                       |
| XLSM safety            | Cached formula; macros present; missing cache              | ingestion-format tests with inert macro and no-cache fixtures                          |
| CSV layouts            | Long form; wide form; unsupported shape                    | ingestion-format tests for UTF-8/BOM, duplicates, ambiguous time, and invalid encoding |
| Time semantics         | Explicit timezone; naive timezone question                 | parsing tests and structured multi-question contract/browser harness                   |
| DatasetBundle result   | Complete success; validation failure                       | parsing pytest and cross-Skill bridge tests                                            |
| Preserve observations  | Gaps and nulls                                             | parsing/processing pytest plus workflow golden                                         |

## Codex session runtime

| Requirement             | Scenarios covered                                                  | Test and evidence                                                                   |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| One conversation/thread | New conversation; continuation                                     | real SDK smoke new/resume and server persistence tests                              |
| SDK control plane       | Run turn; App Server unavailable                                   | `RealCodexAdapter` tests and TypeScript SDK 0.147.0 smoke evidence                  |
| Model scope             | Allowed selection; post-first-turn change; unavailable model       | API tests, browser model-lock assertion, adapter error classification               |
| Workspace isolation     | Write Artifact; modify source; cross-session write                 | workspace and Artifact boundary tests; real workspace-write run                     |
| Read-only internet      | Public read; local-data upload attempt; dependency install attempt | PublicReadGateway tests; AppArmor shell-network canary; sanitized activity tests    |
| Real cancellation       | Active turn; partial Artifact; continue later                      | server cancellation/recovery tests and real Skill-active Chromium cancellation case |
| Restart survival        | Refresh; idle restart; active interruption                         | real browser refresh/SSE/restart harness and repository restart tests               |
| Host identity           | Identity ready; identity missing                                   | doctor and adapter diagnostic tests; real SDK smoke                                 |

## Conversation experience

| Requirement             | Scenarios covered                                    | Test and evidence                                                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Chat workspace          | Professional chat task                               | three real browser workflow cases                                        |
| Desktop layout          | Active desktop; collapsed activity                   | web unit tests and production Chromium shell test                        |
| Sanitized activity      | Running command; reasoning summary; sensitive output | projector/redaction tests and browser activity assertions                |
| Stable events           | SDK representation change; unknown item              | event projector unit tests                                               |
| Question groups         | Multiple questions; restore; invalid response        | contract/server tests and real restart multi-question harness            |
| Layered results         | Quality; forecast; missing visualization             | web unit tests and real quality/forecast Artifact views                  |
| Conversation control    | Search; delete; delete active                        | web/API tests including confirmed deletion                               |
| Model before first turn | Empty; established conversation                      | browser shell/model-lock/refresh tests                                   |
| Truthful terminal state | Completed; cancelled                                 | repository activity reconciliation tests and browser terminal assertions |
| Responsive access       | Tablet; small viewport; reduced motion               | production Chromium responsive/accessibility test                        |

## Dynamic Skill runtime

| Requirement             | Scenarios covered                        | Test and evidence                                                                   |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Repository discovery    | Install; remove                          | doctor discovery tests and dynamic fixture test                                     |
| Codex orchestration     | Forecast selection; new compatible Skill | real workflows plus dynamic proof browser case; no backend Skill-name branch        |
| Common lifecycle        | Start/monitor; resume; cancel            | `tests/skills/test_skillctl_lifecycle.py`, including single-process foreground mode |
| Machine-readable stream | Progress; malformed output               | Skill contract tests and projector rejection tests                                  |
| Instruction-only Skill  | Use instruction-only Skill               | `building-energy-dynamic-proof` real browser case                                   |
| Generic advanced UI     | Compute result; unknown Artifact type    | generic Artifact/event reducer tests and dynamic proof view                         |
| Explicit environments   | Ready; dependency missing                | `scripts/install-skills`, `scripts/skill-doctor`, and doctor tests                  |
| Migrated determinism    | Fixture run; Codex explanation           | four independent pytest suites; workflow golden; real browser summaries             |

## Platform contracts and operations

| Requirement             | Scenarios covered                                                   | Test and evidence                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema source           | Public field change; stale generated output                         | contract golden/invalid/version tests and generated drift check                                                                                               |
| Durable REST            | Retried message; missing resource                                   | API idempotency and problem-detail tests                                                                                                                      |
| Ordered SSE             | Live events; reconnect; no new events                               | SSE integration plus real refresh/reconnect/restart Chromium tests                                                                                            |
| Controlled Artifact     | Valid download; path escape; hash mismatch                          | Artifact service/API integration tests and real download assertions                                                                                           |
| Consistent persistence  | Terminal commit; stop mid-transition                                | repository transaction/restart/interrupted tests                                                                                                              |
| Health and doctor       | All ready; missing Skill environment                                | diagnostic tests and real DGX `scripts/doctor` run                                                                                                            |
| Private correlated logs | Failed Skill; potential secret                                      | logger/export/redaction tests                                                                                                                                 |
| Native DGX operation    | Fresh preparation; start; missing business dependency               | `docs/operations/dgx-native.md`, explicit install/start/doctor scripts                                                                                        |
| Reproducible acceptance | Standard suite; optional full range; unavailable external condition | `scripts/ci-local`, workflow/browser evidence; full-range fixture is honestly `partial` because the controlled 19,678,975-byte fixture is unavailable locally |

## Reproduction commands

```bash
./scripts/install-skills
./scripts/doctor
./scripts/ci-local
pnpm verify:skill-workflows
pnpm smoke:codex

BE_E2E_BASE_URL=http://127.0.0.1:8788 \
BE_E2E_RUN_WORKFLOWS=true \
BE_E2E_RUN_DYNAMIC_SKILL=true \
BE_E2E_RUN_CANCEL=true \
pnpm --filter @building-energy/web exec playwright test e2e/real-service.acceptance.ts
```

The restart/harness cases allocate their own server and require
`BE_E2E_RUN_RESTART=true BE_E2E_RUN_HARNESS=true`. The optional full-date run
must not execute until its SHA-256 matches the value recorded in
`docs/provenance/skills-and-fixtures.md`.
