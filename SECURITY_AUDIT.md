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

## 2026-10-28 — 修复后复核

本次修复改变了上一版审计的前提，以下结论以修复后的代码为准：

- **权限策略已接入实际执行路径**。`AgentRuntime` 用 `PolicyToolExecutor` 包装 `GuardedToolExecutor` 注入 `ReActRunner`，工具调用不再绕过策略。集成测试 `apps/runtime/src/runtime.test.ts` 验证 `write_file` 被拦截且未产生 `tool.completed`。
- **审批是真实的阻断点**。工具被拒绝且携带 `approvalId` 时任务转入 `paused`，不会在副作用未执行的情况下标记完成。
- **审批状态可跨重启恢复**，来源是事件账本而非内存。
- **桌面端不接触模型或工具**：渲染层只消费 SSE 事件流，订阅逻辑在 `apps/desktop-pet/renderer/pet.html`。
- **同步服务有设备认证**：`apps/sync-service` 用 HMAC-SHA256 按设备签发令牌，校验走 `timingSafeEqual`。
- **静态文件服务限制在渲染目录内**（`apps/desktop-pet/src/serve.ts` 校验解析路径前缀）。

仍然存在的缺口（未修复，需在部署前处理）：

- 传输层是明文 HTTP，无 TLS；令牌经 `Authorization` 头发送。
- 审批没有过期与多用户身份体系，`actor` 只是标签。
- 工具执行没有 OS 级沙箱，仅靠路径前缀限制。
- `run_tests` 会以当前用户身份执行 `pnpm test`。
- Benchmark 使用 `FakeProvider`，不含任何外部网络调用，因此不构成对外部服务的风险评估。
