# @agent/cli

命令行客户端。通过 HTTP 调用 `@agent/gateway`，自身不含领域逻辑。

## 启动

先启动 gateway：

```bash
node apps/gateway/dist/main.js --port 4317
```

然后：

```bash
node apps/cli/dist/main.js run "读取 README 并总结要点"
```

## 命令

| 命令 | 说明 |
|---|---|
| `run "<goal>" [--runner <type>]` | 建任务并执行到结束 |
| `show <taskId>` | 打印任务状态 |
| `events <taskId>` | 打印完整事件日志 |
| `approvals <taskId>` | 列出待审批 ID |
| `approve <taskId> <approvalId>` | 批准 |
| `reject <taskId> <approvalId>` | 拒绝 |
| `verify <taskId>` | 确定性验证 |

## 地址

默认 `http://127.0.0.1:4317`，可用 `--url` 或 `AGENT_GATEWAY_URL` 覆盖。

```bash
AGENT_GATEWAY_URL=http://127.0.0.1:4399 node dist/main.js show <taskId>
```

## 退出码

`0` 成功，`1` 任务未完成或验证失败，`2` 参数错误。
