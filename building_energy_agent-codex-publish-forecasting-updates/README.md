# Building Energy Codex Agent

A Codex-native, chat-first Web Agent for deterministic building-energy data
parsing, processing, quality assessment and load forecasting.

The repository is under active implementation of OpenSpec change
`create-building-energy-codex-agent`. The old FastAPI/Agents SDK project is a
read-only algorithm and fixture source; this project has an independent runtime
and public contract.

## Toolchain

- Node.js `24.19.0`
- pnpm `11.21.0`
- Python `3.12`
- `@openai/codex-sdk` and Codex CLI `0.147.0`

Prepare the project-owned Node toolchain and install dependencies explicitly:

```bash
./scripts/bootstrap-toolchain
./scripts/pnpm install --frozen-lockfile=false
```

Business requests never install dependencies. Skill environments are prepared
separately with `./scripts/install-skills` as an explicit operator step.

## Run and verify

```bash
./scripts/doctor
./scripts/dev
```

For an already-built production deployment use `./scripts/start`. See
[`docs/operations/dgx-native.md`](docs/operations/dgx-native.md) for preparation,
configuration, health checks, restart behavior, and deletion boundaries. Run
the complete local gate with `./scripts/pnpm ci:local`.
