# Task ledger

SQLite-backed task state, append-only events, and checkpoint snapshots.

`TaskLedger` supports task creation, event append with `eventId` idempotency, state replay, verification events, checkpoint creation, and checkpoint restoration. Mutations use an immediate SQLite transaction so an invalid transition leaves no partial event or state update.

The package uses Node.js 24's built-in `node:sqlite`; no native SQLite package is required.
