# DGX/Linux native operations

The application runs directly on the DGX host. Installation and business
execution are separate phases: none of `dev`, `start`, the API, Codex turns, or
Skill lifecycle commands install dependencies.

## One-time preparation

From the repository root:

```bash
./scripts/bootstrap-toolchain
./scripts/pnpm install --frozen-lockfile
./scripts/install-skills
./scripts/doctor
```

`bootstrap-toolchain` downloads the pinned Node.js archive from nodejs.org and
checks its published SHA-256 before extracting it under the ignored `.runtime`
directory. `install-skills` creates four isolated Python 3.12 environments from
the checked-in lock files. These are explicit operator actions and require the
network; do not run them from a business request.

The acceptance-only dynamic Skill fixture is installed separately and never
installs a dependency:

```bash
./scripts/install-dynamic-test-skill
```

It exists only to prove that Codex and the generic event/Artifact pipeline can
discover a new instruction-and-script Skill without a server code change.

Codex authentication remains owned by the host. The Web application never asks
for or stores an API key, token, or Codex authentication file. Run `codex login`
outside this application if `doctor` reports that the host identity is not
available.

## Development

```bash
./scripts/dev
```

The script verifies that the configured loopback ports are free, then starts
Fastify on `127.0.0.1:8787` and Vite on `127.0.0.1:5173`. Override them with
`BE_PORT` and `BE_WEB_PORT`. Both child processes are stopped when the script
exits.

## Production build and start

Build during a deployment preparation step:

```bash
./scripts/pnpm ci:local
```

The local gate includes all four isolated Skill test suites, the cross-Skill
contract/format tests, metadata doctor, TypeScript tests, generated-contract
drift, builds, strict OpenSpec validation, formatting, and whitespace checks for
both tracked and not-yet-tracked files.

Start the already-built service without dependency installation:

```bash
BE_HOST=127.0.0.1 BE_PORT=8787 ./scripts/start
```

The production Fastify process serves the built Web application and `/api/v1`
from the same origin. Keep it bound to loopback unless a trusted DGX ingress
provides authentication and TLS. Runtime state is written only beneath
`.runtime/`: SQLite at `.runtime/app.db`, per-session workspaces beneath
`.runtime/sessions`, managed Skill environments beneath `.runtime/skill-envs`,
and bounded structured logs beneath `.runtime/logs`.

The following optional variables change storage locations or operational
limits without changing product semantics:

| Variable                    | Default              | Purpose                         |
| --------------------------- | -------------------- | ------------------------------- |
| `BE_RUNTIME_ROOT`           | `.runtime`           | Runtime state root              |
| `BE_DATABASE_PATH`          | `.runtime/app.db`    | SQLite database                 |
| `BE_MODELS_PATH`            | `config/models.yaml` | Server model allowlist          |
| `BE_CODEX_PATH`             | host `codex`         | Compatible Codex CLI executable |
| `BE_CODEX_APPARMOR_PROFILE` | unset                | Loaded profile granting userns  |
| `BE_CANCEL_TIMEOUT_MS`      | `10000`              | Cooperative-cancel grace period |
| `BE_SSE_HEARTBEAT_MS`       | `15000`              | SSE heartbeat interval          |
| `BE_PUBLIC_READ_MAX_BYTES`  | `10485760`           | Public read response cap        |

### Ubuntu AppArmor user namespace policy

Codex `workspace-write` uses a bwrap user/network namespace to enforce the
session write boundary and direct-shell network denial. On Ubuntu hosts where
`kernel.apparmor_restrict_unprivileged_userns=1`, run `./scripts/doctor` before
starting the service. If the Codex sandbox cannot create a user namespace, an
administrator must install or select an AppArmor profile that explicitly grants
`userns`. On this DGX image the distribution-provided, loaded `linux-sandbox`
profile is suitable:

```bash
BE_CODEX_APPARMOR_PROFILE=linux-sandbox ./scripts/start
```

The launcher accepts only a simple profile name and invokes
`/usr/bin/aa-exec -p <profile> -- codex`. This does not select
`danger-full-access`: Codex still runs with `workspace-write`, approval policy
`never`, and `networkAccessEnabled=false`. Do not create, modify, or load a
system AppArmor profile from a business request; that remains an explicit host
administrator action.

## Health and diagnosis

Use read-only diagnostics first:

```bash
./scripts/doctor
curl --fail http://127.0.0.1:8787/api/v1/health
curl --fail http://127.0.0.1:8787/api/v1/doctor
./scripts/export-diagnostics
```

`./scripts/doctor --probe-models` requests optional model canaries. A configured
model is never silently replaced when a probe fails. Diagnostic output is
designed to contain versions, capability states, recovery commands, and
correlation IDs only; do not attach `.runtime/app.db`, session workspaces, Codex
host authentication data, or raw logs to a support request.

`./scripts/export-diagnostics` writes a mode-`0600` JSON report beneath
`.runtime/diagnostics`. It contains only dependency checks, aggregate state
counts, and bounded log file names/sizes; it excludes session/thread/turn IDs,
prompts, file contents, absolute paths, credentials, environment variables, and
raw log lines.

## Backup, restart, and deletion boundaries

Stop the service before copying `.runtime/app.db` and `.runtime/sessions` for a
consistent backup. On restart, the coordinator preserves terminal history and
marks executions that cannot be proven alive as `interrupted`. Session deletion
removes this application's SQLite records and session directory only after
active processes stop. It does not claim to delete Codex host-private thread
files.
