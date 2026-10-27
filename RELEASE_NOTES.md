# Release notes

## Local MVP — 2026-10-27

Implemented Phases 0–9 of the local-first Agent Runtime MVP:

- protocol, SQLite TaskLedger, replay and checkpoints;
- FakeProvider, streaming ReAct, tools, routing and runner upgrades;
- deterministic policy, approvals, verification, recovery and compensation;
- Rules/Jev decision boundary with safe fallback and Shadow Mode;
- persistent scoped memory and context compression quality checks;
- Fake/Live2D/Electron pet adapter boundary with reconnect;
- local sync envelopes, cursors, idempotency and checkpoint import;
- reproducible LongTask-RR benchmark, A–F reports and standalone SVG demo.

All integrations that need unavailable credentials or assets remain injectable Fake/Mock boundaries. See `progress.md`, `decisions.md`, `SECURITY_AUDIT.md` and `reports/benchmark.md` for evidence and limitations.
