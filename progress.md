# Progress

## Phase 0 — 项目初始化

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 0.1 仓库与目录骨架 | 完成 | Git 初始化、workspace 配置和目录检查通过 | 2026-10-27 |
| 0.2 协议包与统一错误/日志格式 | 完成 | `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（2/2）、`pnpm build` 通过 | 2026-10-27 |
| 0.3 CI 与最终验收 | 完成 | frozen install、lint、typecheck、test（2/2）、build、diff check 全部通过 | 2026-10-27 |
| 0.4 README | 完成 | 项目目标、状态、结构、开发命令、文档和路线图已写明 | 2026-10-27 |

阻塞：无。

## 验证记录

- `pnpm install`：首次受 pnpm 构建脚本审批阻塞；加入 `allowBuilds.esbuild: true` 后通过。
- `pnpm install --frozen-lockfile`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test -- --run`：通过，2 个测试。
- `pnpm build`：通过。

## Phase 0 验收

- Monorepo workspace：15 个 workspace 项目可被 pnpm 识别。
- 统一错误码：`packages/protocol/src/errors.ts`。
- 结构化日志：`packages/protocol/src/logging.ts`。
- 架构文档：`ARCHITECTURE.md`。
- CI：`.github/workflows/ci.yml`。
- 阻塞：无。

## Phase 1 — 协议和任务账本

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 1.1 RuntimeEvent 与共享类型 | 完成 | `protocol` 导出事件、任务、Runner、检查点和验证类型 | 2026-10-27 |
| 1.2 SQLite TaskLedger | 完成 | Node `node:sqlite` 建表、事件追加、任务快照和检查点持久化 | 2026-10-27 |
| 1.3 状态机、回放与幂等 | 完成 | 8 个测试覆盖回放、重复事件、冲突和非法转换回滚 | 2026-10-27 |
| 1.4 重启与检查点恢复 | 完成 | 文件数据库重开后事件仍在，失败任务可恢复到检查点 | 2026-10-27 |
| 1.5 Phase 1 验收 | 完成 | frozen install、typecheck、test（8/8）、build、lint、diff check 全部通过 | 2026-10-27 |

Phase 1 阻塞：无。

### Phase 1 验证记录

- `pnpm install`：通过，workspace 识别 15 个项目。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，2 个测试文件、8 个测试。
- 回放：`replayTask` 从完整事件流重建任务状态。
- 重启：关闭并重新打开同一 SQLite 文件后，任务和事件仍存在。
- 检查点：失败任务恢复为检查点保存的运行状态，并追加恢复事件。
- 非法转换：事务回滚，事件数量和任务状态保持不变。
- LLM、Jev、实际 Runner、Memory、Verifier、Electron、同步系统：未接入。

## Phase 2 — Agent Core

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 2.1 Provider 与 FakeProvider | 完成 | `ModelProvider`、流式事件、可取消 FakeProvider 和模型事件测试 | 2026-10-27 |
| 2.2 ToolRegistry 与安全内置工具 | 完成 | 注册、重复注册、超时、取消、文件读写、工作区路径限制测试 | 2026-10-27 |
| 2.3 ReAct Runner | 完成 | 两轮工具调用、模型增量输出、任务/会话隔离和事件记录测试 | 2026-10-27 |
| 2.4 Phase 2 验收 | 完成 | lint、typecheck、test（15/15）、build 全部通过 | 2026-10-27 |

### Phase 2 验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，5 个测试文件、15 个测试。
- `pnpm build`：通过。
- 模型请求、增量输出、完成和失败会写入 `RuntimeEvent`；工具请求、成功、失败、超时和取消同样写入事件。
- `FakeProvider` 不依赖真实 API，测试中验证流式增量、工具调用和 AbortSignal。
- `ToolRegistry` 用 AbortSignal 和超时定时器隔离工具异常；内置 `read_file`、`write_file`、`run_tests` 受 workspace 根目录和固定命令限制。
- ReAct Runner 每个任务使用独立 session、消息列表和取消控制器，任务状态可由事件回放重建。

Phase 2 限制：真实模型 Provider、重试策略、权限审批和回滚属于后续 Phase；当前仅提供可替换接口和离线 FakeProvider。桌面、Jev、Memory、Verifier、同步系统仍未接入。

## Phase 3 — Runner Router

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 3.1 TaskProfile 特征提取 | 完成 | 识别步骤数、复杂度、固定流程、长任务和外部副作用信号 | 2026-10-27 |
| 3.2 规则路由与证据 | 完成 | `route.decided` 事件保存 runner、理由、特征证据和置信度 | 2026-10-27 |
| 3.3 多 Runner 适配 | 完成 | ReAct、Planner-Executor-Verifier、State Graph、Background Runner 接口和离线执行路径 | 2026-10-27 |
| 3.4 动态升级与验收 | 完成 | 连续失败从 Direct 升级 PEV；18 个测试、typecheck、lint 通过 | 2026-10-27 |

### Phase 3 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，6 个测试文件、18 个测试。
- `route.decided` 事件参与事件回放，不改变任务状态事实来源。
- 简单任务使用 ReAct；固定流程使用 State Graph；长任务使用 Background；复杂或有副作用任务使用 Planner-Executor-Verifier。
- PEV 支持离线 Planner 和确定性 Verifier；Verifier 结果追加 `verification.recorded`，不由模型自行宣布完成。

Phase 3 限制：当前 Runner 适配器复用 ReAct 执行器，复杂 Planner、图节点和后台队列的生产级持久化调度留给后续安全恢复与发布阶段；路由本身已可测试、记录和回放。

## Phase 4 — 安全、验证和恢复

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 4.1 风险分类和权限策略 | 完成 | 删除/迁移/部署等命令分类；高风险拒绝或要求审批，写文件默认审批 | 2026-10-27 |
| 4.2 人工审批和副作用检查点 | 完成 | `ApprovalManager` 记录申请/决定；中高风险执行前创建 SQLite checkpoint | 2026-10-27 |
| 4.3 Deterministic Verifier | 完成 | 任务完成状态和事件回放一致性检查，结果写入 `VerificationResult` | 2026-10-27 |
| 4.4 恢复、重试和补偿 | 完成 | Retry、checkpoint restore、三类补偿动作和失败事件测试 | 2026-10-27 |
| 4.5 Phase 4 验收 | 完成 | lint、typecheck、test（21/21）、build 全部通过 | 2026-10-27 |

### Phase 4 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，8 个测试文件、21 个测试。
- `pnpm build`：通过。
- 确定性策略直接阻止 critical 操作；high/medium 操作在 `ApprovalManager` 明确批准后才可执行。
- `GuardedToolExecutor` 在副作用前建立 checkpoint，`RecoveryManager` 支持恢复和有上限重试。
- `CompensationRegistry` 逆序执行注册动作，并为成功/失败追加 `compensation.executed`；测试覆盖文件恢复、删除和记录恢复三类补偿语义。
- Jev 未接入权限决定，后续 Phase 只能提供建议，不能绕过此策略。

Phase 4 限制：当前审批状态为本地内存实现，补偿动作由调用方注册，恢复未接入进程监督器；这些边界会在同步、桌宠和 Benchmark 阶段继续验证。

## Phase 5 — Jev Decision Layer

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 5.1 DecisionProvider 与规则层 | 完成 | `RulesDecisionProvider` 支持 tool/stop/escalate/approval/runner 有限选项 | 2026-10-27 |
| 5.2 Jev Adapter 与超时回退 | 完成 | 可替换 transport、AbortSignal、超时/错误自动回退 rules/strong | 2026-10-27 |
| 5.3 置信度与 Shadow Mode | 完成 | 阈值过滤低置信度，Shadow 记录非权威 Jev 与权威规则结果 | 2026-10-27 |
| 5.4 安全和验收 | 完成 | high/critical approval 永远由确定性规则决定；25 个测试通过 | 2026-10-27 |

### Phase 5 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，9 个测试文件、25 个测试。
- Jev 调用记录 provider、choice、置信度、延迟、回退标记和权威性到 `decision.evaluated`。
- Jev transport 超时或抛错时自动回退；低置信度或非法选项不会改变规则结果。
- 高风险审批即使 Jev 返回 approve，也强制使用确定性 review/阻断结果。

Phase 5 限制：Jev 目前是注入式 transport，未连接真实服务；成本比较和统计报告在 Phase 9 Benchmark 完成。
