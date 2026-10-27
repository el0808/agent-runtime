# Security audit

Date: 2026-10-27

- High and critical tool operations are classified by deterministic code. Critical destructive commands are denied; high-risk operations require an explicit `ApprovalManager` decision.
- Jev results are advisory. `DecisionRouter` ignores Jev approval for high/critical risk and writes decision evidence to `decision.evaluated`.
- `GuardedToolExecutor` creates a checkpoint before medium/high side effects. Recovery and compensation results are written to the event ledger.
- Built-in tools allow workspace-scoped UTF-8 file access and a fixed `pnpm test` command. Arbitrary shell commands and path traversal are rejected.
- The pet adapter receives RuntimeEvent-derived display messages only. It has no Provider, ToolRegistry, or approval access.
- Sync import uses event IDs, versions and idempotency keys; stale records do not overwrite newer records, and same-version differences are reported as conflicts.
- The benchmark and HTML demo use offline code and contain no API keys, network credentials, or external model assets.

The audit covers the local MVP boundaries. Production deployment, remote authentication, code signing, sandboxing and third-party resource licenses require a separate deployment review.
