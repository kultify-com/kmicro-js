# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

kmicro-js (`@kultify/kmicro-js`) is a microservice framework built on NATS micro services with built-in OpenTelemetry distributed tracing and Pino logging. Services communicate via NATS request/response with binary (Uint8Array) payloads and automatic header propagation.

## Commands

- **Install**: `pnpm install`
- **Build**: `pnpm build` (uses tsup, outputs ESM + CJS to `dist/`)
- **Test**: `pnpm test` (vitest, uses testcontainers — requires Docker running)
- **Run single test**: `pnpm vitest run -t "test name pattern"`
- **Lint**: `pnpm lint` (biome lint)
- **CI**: `pnpm ci` (biome ci + vitest run)

## Code Style

- **Formatter/Linter**: Biome with recommended rules
- **Indentation**: Tabs
- **Quotes**: Double quotes for JS/TS
- **Import organization**: Biome handles import sorting
- **Module system**: ESM (`"type": "module"`) — use `.js` extensions in imports even for `.ts` files

## Architecture

All source code is in `src/KMicro.ts` (single-file library). Key exports:

- **`init(nats, serviceName, version, description?, enableOtel?)`** — factory that creates and connects a `Kmicro` instance
- **`Kmicro`** — main class: connects to NATS, registers endpoints, makes calls, manages OTel lifecycle
- **`RequestContext`** — passed to endpoint handlers, carries OTel context/span, NATS connection, logger, and metadata. Handlers use `context.call()` to make downstream calls (preserves trace + headers)
- **`CallError`** — thrown when a remote call returns a NATS service error

### Request Flow

1. `Kmicro.addEndpoint(name, handler)` registers a NATS micro endpoint under `serviceName.name`
2. Incoming requests: OTel context extracted from NATS headers → span created → handler invoked with `RequestContext` and raw `Uint8Array` data
3. `call(target, payload)` addresses services as `"serviceName.actionName"` with 5s default timeout
4. Headers (including custom ones) propagate through the call chain automatically
5. Call depth tracked via `kmc-depth` header, max depth 20 to prevent infinite loops

### Moleculer Integration

`Kmicro.call()` accepts `moleculerTrace` option to bridge Moleculer trace contexts into OTel — converts Moleculer traceId/parentId to W3C traceparent format.

## Testing

Tests use `@testcontainers/nats` to spin up NATS in Docker. OTel is disabled in tests (`enableOtel=false`). Services use `randomUUID()` names for isolation.
