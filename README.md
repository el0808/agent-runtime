# Agent Runtime

本项目是一个本地优先、可验证、可恢复的 Agent Runtime + Harness，目标是让长任务具备明确的状态、权限、检查点、验证和恢复能力，并为 Electron + Live2D 桌宠提供稳定的展示层接口。

当前已完成 **Phase 0：项目初始化**、**Phase 1：协议和任务账本** 和 **Phase 2：Agent Core**。真实模型、复杂 Runner、安全恢复、记忆、同步和桌宠接入仍按路线图逐步实现。

## 目标

- 根据任务复杂度选择合适的 Runner。
- 保存任务状态、事件、检查点、工具结果和验证证据。
- 在进程崩溃、工具失败或网络异常后恢复任务。
- 对外部副作用执行权限检查、审批、验证和补偿。
- 让桌宠只负责展示 Runtime 状态，不直接拥有模型或工具权限。

## 当前状态

已完成 Phase 0：

- pnpm workspace，包含 4 个应用入口和 11 个领域包边界。
- TypeScript strict、Node ESM、ESLint、Vitest。
- `@agent/protocol` 共享包，包含稳定错误码和 JSON 结构化日志。
- 架构、进度和决策记录。
- GitHub Actions CI：安装、lint、类型检查、测试和构建。

已完成 Phase 1：

- `@agent/protocol` 定义 `RuntimeEvent`、`TaskProfile`、`RunnerType`、`Checkpoint`、`VerificationResult` 和 `Runner`。
- `@agent/task-ledger` 使用 Node.js 内置 `node:sqlite` 持久化任务、事件和检查点。
- 事件追加使用 `eventId` 幂等；状态变化在 `BEGIN IMMEDIATE` 事务内校验和写入。
- 任务状态可以从完整事件流回放；进程重启后可以继续读取任务、事件和检查点。
- 非法状态转换会被拒绝并回滚，不接入 LLM、Jev、实际 Runner、Memory、Verifier、Electron 或同步系统。

已完成 Phase 2：

- `@agent/runner` 提供可替换的 `ModelProvider`、`FakeProvider` 和最小 ReAct Runner。
- `@agent/tools` 提供 ToolRegistry、AbortSignal 超时/取消，以及受工作区限制的文件读写和固定测试工具。
- 模型增量、工具调用、失败、超时、取消和 session 生命周期均写入 RuntimeEvent；每个任务使用独立 session 和消息历史。

已完成 Phase 3：

- `@agent/routing` 根据任务目标和 metadata 提取复杂度、步骤、固定流程、长任务及副作用特征。
- 规则路由支持 ReAct、Planner-Executor-Verifier、State Graph 和 Background，并在连续失败时动态升级。
- 每次路由追加 `route.decided` 事件，记录理由、证据、置信度和升级来源；PEV 可接入确定性离线 Verifier。

## 目录结构

```text
apps/
  runtime/          Agent Runtime 进程
  gateway/          HTTP、WebSocket、JSON-RPC 接口
  desktop-pet/      Electron + Live2D 展示层
  cli/              命令行客户端

packages/
  protocol/         共享事件、错误码和日志类型
  task-ledger/      SQLite 任务状态、事件日志和检查点
  runner/           Runner 接口和实现
  policy/           权限、审批和安全规则
  tools/            工具注册和执行
  verifier/         确定性结果验证
  memory/           多级记忆和上下文压缩
  routing/          Runner 和决策路由
  sync/             本地导入导出和跨设备同步
  pet-adapter/      Runtime 事件到桌宠状态的映射

storage/
  artifacts/        任务产物
  checkpoints/      检查点数据
```

依赖方向从 `protocol` 开始向上：领域包可以依赖共享协议，应用可以依赖领域包；共享协议不依赖应用或外部服务。

## 开始开发

要求：Node.js 24+、pnpm 11.25.0。账本使用 Node.js 24 内置的 `node:sqlite`，不需要额外原生 SQLite 依赖。

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

常用脚本：

| 命令 | 用途 |
|---|---|
| `pnpm install --frozen-lockfile` | 按锁文件安装依赖 |
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 项目引用检查 |
| `pnpm test` | Vitest 测试 |
| `pnpm build` | 构建共享包 |
| `pnpm test:watch` | 监听模式运行测试 |

## 文档

- [PLAN.md](./PLAN.md)：总体目标、阶段计划和最终验收标准。
- [ARCHITECTURE.md](./ARCHITECTURE.md)：目录边界、依赖方向和 Phase 0 契约。
- [progress.md](./progress.md)：按步骤记录验证结果和阻塞情况。
- [decisions.md](./decisions.md)：重要技术决策及原因。

## 路线图

```text
协议与账本
  → Agent Core
  → ReAct Runner
  → Planner / Verifier
  → 检查点与恢复
  → Jev 路由
  → 记忆与压缩
  → 桌宠接入
  → 跨设备同步
  → Benchmark 与发布
```

外部项目（如 Pi、Open Yachiyo、Jev、LangGraph、Temporal、Letta、Mem0）只会在确认接口和许可证后通过适配器接入，不会在 Phase 0 直接成为核心依赖。
