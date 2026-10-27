# 计划一致性核查报告

- 核查对象：`agent-runtime-main`（本地副本，非 git 仓库）
- 对照基准：`PLAN.md`（v1，510 行）
- 核查日期：2026-10-28
- 核查方式：全量阅读 115 个文件 / 3961 行 TypeScript；在 `/tmp` 副本中实跑 lint、typecheck、test、build，原目录未做任何修改
- 结论摘要：**包级实现质量合格，系统级集成缺失，PLAN.md 的全量勾选不成立**

---

## 一、实测验证结果

核查时将项目复制到临时目录安装依赖并执行原始命令，结果如下（非引用 `progress.md`）：

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 通过 | 155 个包，构建脚本已放行 esbuild |
| `pnpm lint` | 通过 | 无告警 |
| `pnpm typecheck` | 通过 | `tsc -b` 11 个 project references |
| `pnpm test` | 通过 | 13 个测试文件，35 个测试，0 失败 |
| `pnpm build` | 通过 | 仅构建 `packages/*`，不构建 `apps/*` |

**注意**：测试全绿，但每个测试只验证自己包内部的函数行为，没有任何一条测试穿过两个以上包的运行时链路。

---

## 二、阻断级问题

### A1　`apps/` 四个入口全部是空壳

```
apps/runtime/       README.md + package.json（4 行，无 dependencies/scripts）
apps/gateway/       README.md + package.json（同上）
apps/cli/           README.md + package.json（同上）
apps/desktop-pet/   README.md + package.json（同上）
```

- 无 `src/` 目录
- 无 `tsconfig.json`
- 根 `tsconfig.json` 的 11 个 references 全部指向 `packages/*`，不包含任何 app

**后果**：整个仓库不存在任何可执行入口。`pnpm build` 只产出库文件。PLAN §2 声明的 `apps/runtime`（Agent 核心运行时）、`apps/gateway`（HTTP/WS/JSON-RPC 接口）、`apps/cli`（命令行客户端）均未实现。

### A2　跨包零装配

对 PLAN §5 要求的核心能力类做全局引用检索，结果：

| 组件 | 出现位置 | 生产代码调用方 |
|---|---|---|
| `GuardedToolExecutor` | `policy/src/policy.ts`、`policy.test.ts` | 无 |
| `MemoryStore` | `memory/src/store.ts`、`memory.test.ts` | 无 |
| `ContextCompressor` | `memory/src/compression.ts`、`memory.test.ts` | 无 |
| `RunnerRouter` | `routing/src/router.ts`、`router.test.ts` | 无 |
| `DecisionRouter` | `routing/src/decision.ts`、`decision.test.ts` | 无 |
| `DeterministicVerifier` | `verifier/src/verifier.ts`、`verifier.test.ts` | 无 |
| `CompensationRegistry` | `policy/src/recovery.ts`、`policy.test.ts` | 无 |
| `RecoveryManager` | `policy/src/recovery.ts`、`policy.test.ts` | 无 |
| `SyncEngine` | `sync/src/ledger-sync.ts` | 无 |

PLAN §2 的核心数据流 `用户输入 → Task Classifier → Policy Engine → Runner Router → Jev → Runner → Tools/Memory/Verifier → Checkpoint → 输出` 从未被任何代码串联起来。

### A3　安全策略在实际执行路径上被绕过

`ReActRunner.run()` 是当前唯一会真正执行工具的路径，它直接调用：

```ts
// packages/runner/src/react-runner.ts:137
const result = await this.tools.execute(call.toolName, call.input, {...});
```

而没有经过 `GuardedToolExecutor`。因此：

- `ToolPermissionPolicy`（风险分级）不生效
- `ApprovalManager`（人工审批）不触发
- 副作用前的 `checkpoint` 不创建

`SECURITY_AUDIT.md` 中"High and critical tool operations are classified by deterministic code"实际只对直接使用 `GuardedToolExecutor` 的调用方成立，而这样的调用方在生产代码中为零。

**这是本次核查最严重的单点问题**：安全边界写完了，但没有接在必经路径上。

### A4　Benchmark 指标为硬编码常量

`packages/benchmark/src/offline.ts:3-10`：

```ts
"A-strong-baseline":             { costUsd: 1,    tokens: 7000, latencyMs: 1000, success: 0.96 },
"B-fast-baseline":               { costUsd: 0.35, tokens: 3200, latencyMs: 680,  success: 0.88 },
"C-runtime-no-jev":              { costUsd: 0.62, tokens: 4100, latencyMs: 790,  success: 0.94 },
"D-runtime-jev":                 { costUsd: 0.55, tokens: 3600, latencyMs: 620,  success: 0.95 },
"E-runtime-jev-verifier":        { costUsd: 0.58, tokens: 3800, latencyMs: 650,  success: 0.97 },
"F-runtime-jev-verifier-recovery":{ costUsd: 0.6, tokens: 3900, latencyMs: 670,  success: 0.97 }
```

`success` 由 `deterministicSuccess()` 用 hash 与上述常量比较得出；`recoverySucceeded` 与 `resumeSucceeded` 由 `config === "F" || !task.requiresRecovery` 布尔判断得出，**必然 100%**；`rollbackResidual` 是三目表达式常量。

`reports/benchmark.md` 中的"+0.3 个百分点成功率、成本降低 40%、耗时降低 33%"全部由这些字面量推导，不构成任何实验证据。

PLAN §6 要求的"A～F 六组对照实验""Jev、Verifier、压缩、恢复的消融实验"未发生。

---

## 三、高优先级问题

### B1　`rollback` 未实现，与已完成状态矛盾

```ts
// packages/runner/src/react-runner.ts:186-189
async rollback(taskId: string): Promise<void> {
  void taskId;
  throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "Rollback is implemented in Phase 4" });
}
```

PLAN Phase 4 已标记 `[x]` 完成。PLAN §8 第 5 条"能撤销至少三类外部副作用"不成立——`CompensationRegistry` 是手工注册动作的数组，与 checkpoint 无关联，且无调用方。

### B2　Phase 4 验收未执行

PLAN 该阶段验收为"注入进程崩溃、网络失败和工具失败后可以继续任务"。仓库中：

- 无崩溃注入测试
- 无网络故障模拟
- `RecoveryManager.recover()` 无进程监督器接管，仅在单测中被手动调用

### B3　两种 Runner 类型是死枚举

`RUNNER_TYPES` 声明 6 种（direct / planner-executor-verifier / state-graph / multi-agent / background / transactional），但 `RunnerRouter` 的 Map 只注册 4 种：

```ts
// packages/routing/src/router.ts:32-37
[RUNNER_TYPES.DIRECT, ...],
[RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER, ...],
[RUNNER_TYPES.STATE_GRAPH, ...],
[RUNNER_TYPES.BACKGROUND, ...]
```

`multi-agent` 与 `transactional` 若被请求会抛 `Runner ... is not configured`。PLAN §3 的 Runner 类型清单未完整覆盖。

### B4　Planner / State Graph / Background 是委托壳

- **Planner**：默认实现 `(profile) => [profile.goal]`，即"计划"就是目标原文；`plan` 变量在 `PlannerExecutorVerifierRunner.run()` 中被计算后仅做 `length === 0` 检查，随后丢弃，并未驱动执行
- **State Graph**：节点执行完毕后仍 `yield* this.delegate.run(taskId)`，图与 ReAct 是串联而非替代关系
- **Background**：仅用一个 `Set<string>` 防重入，无调度器、无持久化队列、无崩溃后重入

### B5　Verifier 未接入，任务完成仍由模型自述决定

`DeterministicVerifier` 从未被构造。`PlannerExecutorVerifierRunner` 的 `verifier` 参数可选，默认 `undefined`。

而在 `ReActRunner` 中：

```ts
// packages/runner/src/react-runner.ts:130-133
if (toolCalls.length === 0) {
  yield this.append({ ... type: RUNTIME_EVENT_TYPES.TASK_COMPLETED, payload: { summary: text } });
  ...
}
```

模型停止调用工具即标记任务完成。这直接违反 PLAN §5"Agent 不能只根据自己的文字回复宣布任务完成"。

### B6　审批状态不持久

```ts
// packages/policy/src/policy.ts:49
private readonly decisions = new Map<string, "approved" | "rejected" | "expired">();
```

进程重启后已批准记录全部丢失，与 PLAN"可恢复"的核心定位冲突。审批事件虽写入账本，但读取侧不回灌内存状态。

---

## 四、中优先级问题

### C1　记忆与压缩未参与任务流程

`MemoryStore` 与 `ContextCompressor` 实现完整且有测试，但 `ReActRunner` 每轮从 `task.profile.goal` 重建 `messages`：

```ts
// packages/runner/src/react-runner.ts:79
const messages: ChatMessage[] = [{ role: "user", content: task.profile.goal }];
```

不读记忆、不触发压缩、不在跨轮次/跨恢复时保留上下文。PLAN §5"主动上下文压缩"在当前系统中是离线工具，不是运行特性。

### C2　Phase 7 无任何 Electron / Live2D 实现

PLAN 勾选"接入 Open Yachiyo 的 Electron/Live2D 展示层""接入语音和口型同步"。实际仓库中：

- `package.json` 无 electron、pixi、live2d 依赖
- `Live2DPetAdapter` 只依赖一个 `createTransport` 函数
- `ElectronPetAdapter` 只调用 `ipc.send("runtime-pet-event", event)`
- `VoiceAdapter` 是接口声明，无实现

即：只有适配器边界，没有展示层。

### C3　Phase 8 设备认证不成立

`DeviceIdentityStore` 生成并读取一个含 UUID 的 JSON 文件，无签名、无令牌、无对端校验。同步仅有本地 JSON 文件，无远程传输、无服务端。

### C4　Phase 9 公开数据集未接入

`importPublicJsonlDataset()` 无调用方。仓库中不存在 Terminal-Bench / τ-bench / BFCL / AndroidWorld / LongMemEval 的任何数据或适配代码。`benchmarks/config.json` 与 `benchmarks/long-task-rr.json` 未被任何代码读取（`scripts/run-benchmark.mjs` 直接调用 `createLongTaskRR(30)`），属于装饰性配置。

### C5　死代码 `routeEvent`

```ts
// packages/routing/src/runners.ts:106
export function routeEvent(...): RuntimeEvent {
  return { eventId: randomUUID(), taskId, sequence: 0, ... } as RuntimeEvent;
}
```

生成 `sequence: 0` 的伪造事件，若被 `ledger.appendEvent` 使用会触发 `CORRUPT_LEDGER`。当前无调用方，但保留即是隐患。

### C6　非 git 仓库

PLAN Phase 0 勾选"建立 Git 分支和 CI"。目录下无 `.git`，`progress.md` 引用的 CI run `40510856353` 无法核对。

---

## 五、PLAN §1–§5 逐条对照

| PLAN 条目 | 判定 | 依据 |
|---|---|---|
| §1 总体目标（10 项能力） | ⚠️ 接口齐、端到端无 | 每项有对应类型或类，无一项能通过入口跑通 |
| §2 总体框架（目录 + 数据流） | ⚠️ 目录齐、数据流断 | `apps/*` 空；核心链路未串联（A1/A2） |
| §3 Agent/Harness 分层与 Runner 契约 | ✅ 契约 / ❌ 实现 | `Runner` 五方法签名与 PLAN 一致；6 种 Runner 仅 4 种可路由（B3） |
| §4 可复用开源项目 | ❌ 未接入 | Pi、Open Yachiyo、Jev、LangGraph、Temporal、Letta、Mem0 均未接入；存储用 `node:sqlite` 而非 PLAN 所写 SQLite/Drizzle |
| §5 任务账本 | ✅ | 事件为事实来源、快照为读缓存、幂等、事务、回放，均有测试 |
| §5 多 Runner 动态升级 | ⚠️ | 规则升级可用；无 transactional；PEV/图/后台为壳（B4） |
| §5 可验证执行 | ⚠️ | Verifier 存在但未接线（B5） |
| §5 可恢复可撤销 | ⚠️ | checkpoint 与重试可用；rollback 为空（B1） |
| §5 记忆与上下文压缩 | ⚠️ | 工具层成立，任务层不成立（C1） |
| §5 Jev 决策层 | ✅ 作为边界 | 注入式 transport、超时回退、置信度阈值、高风险强制走规则，均有测试；无真实 Jev |
| §5 跨设备同步 | ⚠️ | 账本级导入恢复有测试；无设备认证、无网络服务（C3） |

---

## 六、PLAN §6（Phase 0–9）逐阶段验收

PLAN 中全部标记 `[x]`，实际状态：

| Phase | PLAN 验收标准 | 实际状态 | 判定 |
|---|---|---|---|
| 0 初始化 | monorepo / CI / 文档 | 配置与 CI 文件真实存在；无 git 仓库 | ✅ |
| 1 协议与账本 | 重启后可读任务状态与完整事件 | 有重开、回放、幂等、非法转换回滚测试 | ✅ 真做完 |
| 2 Agent Core | 可完成简单文件读取/修改/测试任务 | 两包各自有测试；无"模型→工具→文件→测试"联合用例；无真实 Provider | ⚠️ 部分 |
| 3 Runner Router | 同一任务按复杂度选不同 Runner | 路由规则与 `route.decided` 事件有测试 | ⚠️ 路由成立，Runner 实现为壳 |
| 4 安全验证恢复 | 注入崩溃/网络/工具失败后可继续 | 仅单测；rollback 未实现；策略未接入 Runner | ❌ |
| 5 Jev 集成 | 不可用时回退强模型 | 超时/异常/低置信度回退与高风险绕过均有测试 | ✅ 作为边界成立 |
| 6 记忆与压缩 | 压缩后任务可继续，可查看/恢复原始记录 | 存储、版本、冲突、原始消息保留有测试；压缩不参与任务循环 | ⚠️ 工具层成立，验收场景不成立 |
| 7 桌宠 | 事件稳定驱动桌宠，重启不影响任务 | 仅 Fake 适配器与映射表；无 Electron、无 Live2D | ❌ |
| 8 跨设备同步 | 设备 B 可查看并恢复设备 A 任务 | 账本级导入恢复有测试；无认证、无远程 | ⚠️ 半 |
| 9 Benchmark 发布 | A–F 对照、消融、成本/token/延迟 | 指标为硬编码常量；未跑实验；未接公开数据集 | ❌ |

### PLAN §8 最终验收 12 条

| # | 条目 | 判定 |
|---|---|---|
| 1 | 能完成普通工具任务 | ⚠️ 无入口，仅库级可调用 |
| 2 | 能自动选择不同 Runner | ⚠️ 路由层成立，选择后多数落到 ReAct |
| 3 | 能在失败和崩溃后恢复 | ❌ 无崩溃注入验证 |
| 4 | 能验证最终结果 | ❌ Verifier 未接入 |
| 5 | 能撤销至少三类外部副作用 | ❌ rollback 未实现 |
| 6 | 能主动压缩上下文 | ❌ 未接入任务循环 |
| 7 | 用户能查看和编辑记忆 | ✅ 库级 API 完整 |
| 8 | Jev 故障时能安全回退 | ✅ |
| 9 | 桌宠只作为展示层工作 | ✅ 边界成立（但无展示层） |
| 10 | 另一台设备能继续任务 | ⚠️ 本地文件级成立，无远程 |
| 11 | Benchmark 成功率接近强模型基线 | ❌ 数字为常量 |
| 12 | 成本与耗时明显下降 | ❌ 数字为常量 |

---

## 七、可维护性与可读性

### 做得好的地方

1. **类型设计扎实**：`RuntimeEvent` 用映射类型 + `satisfies never` 兜底（`state-machine.ts:304`），新增事件类型时编译器强制处理，不会漏分支。
2. **不变式清晰且贯彻**："事件流是事实来源，`tasks.state_json` 是事务内同步的读快照"，在 `decisions.md` 与代码中一致。
3. **编译期防线到位**：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` 全开。
4. **`task-ledger` 包可读性最佳**：单一职责、事务封装统一、错误码路由正确，是仓库里的样板文件。

### 需要改善的地方

1. **代码风格两极分化**。`task-ledger.ts` 排版规范；而 `memory/store.ts`、`policy.ts`、`verifier.ts`、`benchmark/report.ts` 被压缩成单行，`MemoryStore.search()`、`update()`、`renderMarkdown()` 单行超过 200 字符，修改时需横向滚动定位。ESLint 未配置 `max-len`，未形成约束。
2. **重复实现**：
   - `stableJson`（`task-ledger.ts:61`）与 `stable`（`sync/store.ts:44`）是同一段代码
   - `failure`（`react-runner.ts:30`）与 `failureFrom`（`tools/registry.ts:59`）是同一段代码
   - `routeEvidence` 有调用方，`routeEvent` 是死代码
3. **文档与代码严重脱节**：`README.md:5` 仍写"当前已完成 Phase 0、Phase 1 和 Phase 2"，而同文件 `README.md:76` 起已列出 Phase 9 完成；`progress.md`、`decisions.md`、`RELEASE_NOTES.md`、`SECURITY_AUDIT.md` 均按"已实现"口径描述。这对后续接手者的误导风险高于代码缺陷本身。
4. **无 schema 校验**：工具输入仅靠零散 `requiredString` / `typeof` 检查，`ToolDefinition.validate` 钩子在测试之外从未注册。
5. **无端到端测试**：13 个测试文件全部为包内单测。

---

## 八、建议处理顺序

按"会不会让后续判断建立在错误前提上"排序：

1. **修正文档口径** — 让 `README.md:5`、`progress.md`、`RELEASE_NOTES.md` 与代码实际状态一致，取消 PLAN 中未达成的勾选，或改为"接口就绪"与"端到端可用"两列。
2. **接通安全路径** — 让 `ReActRunner` 经 `GuardedToolExecutor` 执行工具，或在 Runner 层前置策略校验；否则 `SECURITY_AUDIT.md` 的结论不成立。
3. **建立最小可执行入口** — 先在 `apps/runtime` 落一个把 ledger + runner + policy + verifier 串起来的 `main`，使 A1/A2 可被端到端测试覆盖。
4. **实现 rollback 或明确降级** — 消除 `B1` 与 Phase 4 完成标记的矛盾。
5. **重做 Benchmark** — 用真实 Runner 执行 LongTask-RR，或明确标注为"常量占位、非实验结论"。

---

## 九、核查范围与未覆盖项

**已覆盖**：全部 `packages/**/*.ts` 源码、全部测试文件、全部 Markdown 文档、构建与 CI 配置、benchmark 脚本与产物。

**未覆盖**：
- 未逐条审阅各测试文件的断言强度，仅确认覆盖范围
- 未核验 `artifacts/pelican-bicycle.html` 的渲染效果
- 未做运行时性能实测（benchmark 为常量，无实测基础）
- 未核验 `progress.md` 引用的 CI run `40510856353`（无 git 历史）

**本次核查未修改任何源码或配置文件**；所有验证在临时副本中执行。
