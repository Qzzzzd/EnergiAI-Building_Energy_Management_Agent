# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React/Vite Web, Node.js/TypeScript/Fastify server, shared Zod contracts, SQLite
and filesystem persistence, TypeScript `@openai/codex-sdk`, and Python 3.12 only
for four deterministic compute Skills. This stack was explicitly fixed in the
approved OpenSpec change.

## Users

Building-energy engineers and operators working on a single-user DGX/Linux host.
They upload metering workbooks or deterministic CSV exports, ask for processing,
quality assessment or load forecasting, monitor long computation, resolve real
ambiguities, and decide whether the evidence is trustworthy.

## Product Purpose

Complete building-energy analysis inside one persistent conversation. Success
means the user can see what Codex and each Skill are doing, intervene when input
is truly required, and trace every business conclusion to validated artifacts.

## Positioning

Codex owns planning and native Skill selection while deterministic Python Skills
own business computation. The Node server remains generic: it provides session,
security, lifecycle, event and artifact capabilities without hard-coding the
three business flows or individual Skill names.

## Operating Context

The product runs natively on DGX/Linux using the host's existing Codex identity.
One Web conversation maps to one Codex thread and one isolated session workspace.
Inputs are immutable XLSX, read-only XLSM or strict UTF-8 comma-separated CSV
snapshots. Conversations and files remain until the user confirms deletion.

## Capabilities and Constraints

- Forecast, data-quality and integrated analysis use explicit Bundle
  prerequisites between four project Skills.
- Default forecasts cover 24 hours in `Asia/Shanghai`; target ambiguity requires
  structured user input.
- Up to 10 files and 200 MB total are accepted per upload request; each file is
  also limited to 200 MB.
- The model and reasoning level come from a server allowlist and lock after the
  first turn.
- Public internet access is read-only and observable. Local data, credentials,
  external writes and runtime dependency installation are prohibited.
- Results must distinguish success, partial success, input required, failure,
  cancellation and interruption. No placeholder visualizations or invented
  metrics are permitted.

## Brand Commitments

Chinese-first, professional and calm. The product is branded **EnergiAI / 建筑
能源专业智能体**. Its visual language follows a warm-white and mist-beige work
surface, deep green primary actions and current selection, load-orange attention,
failure-red alerts, and restrained pipework-gray structure. The left business
rail, dense typography, and progressive disclosure keep the conversation primary;
the activity inspector's truthful load trajectory supports the work instead of
turning the product into a terminal or workflow console.

## Evidence on Hand

The read-only source project contains four deterministic Skills at commit
`a0d039569b9ef26a98128b529add0e0ead3d3e08` and a 2,951,705-byte three-workflow
fixture. Source provenance and copied fixture hashes must be recorded in this
repository. No customer claims, testimonials or production performance
benchmarks are available and none may be fabricated.

## Product Principles

- Chat first; execution detail supports the conversation rather than replacing it.
- Deterministic artifacts are authoritative; natural language explains them.
- Autonomy is bounded by observable contracts, isolated workspaces and honest states.
- Dynamic Skills extend capability without new backend business branches.
- Recovery, cancellation and deletion must change real state, not only the UI.

## Accessibility & Inclusion

Keyboard operation, visible focus, dialog focus management, reduced motion,
non-color status cues, chart text alternatives and data-table fallbacks are
required across desktop, tablet and small-screen layouts.
