# Agent Runtime Architecture

## Phase 0 boundary

Phase 0 establishes the TypeScript and Node.js monorepo boundary. Runtime behavior, persistence, runners, model providers, synchronization, and desktop presentation remain future phases.

## Repository layout

```text
apps/                  deployable entry points
  runtime/             core runtime process
  gateway/             HTTP, WebSocket, and JSON-RPC boundary
  desktop-pet/         Electron and Live2D presentation
  cli/                 command-line client
packages/              reusable domain packages
  protocol/            shared events, errors, and log records
  task-ledger/         task state, events, and checkpoints
  runner/              runner interfaces and implementations
  policy/              permissions, approvals, and safety rules
  tools/               tool registration and execution
  verifier/            deterministic result verification
  memory/              memory scopes and context compression
  routing/             runner and decision routing
  sync/                local export and cross-device synchronization
  pet-adapter/         runtime events to desktop-pet state
storage/               local runtime data and generated artifacts
```

## Dependency direction

`protocol` is the lowest-level shared contract. Domain packages may depend on `protocol`; applications may depend on domain packages. `protocol` must not depend on an application or an external service. Storage adapters stay behind package interfaces so SQLite can be replaced later without changing task behavior.

## Phase 0 contracts

- Errors use stable machine-readable codes and human-readable messages.
- Logs are JSON-serializable records with an ISO-8601 timestamp, level, event name, and message.
- Root scripts provide one command each for build, lint, type checking, and tests.
- CI runs the same commands used locally.
