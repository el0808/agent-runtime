# @agent/gateway

Agent Runtime 的控制面。零依赖 HTTP 实现，提供 REST、SSE 与 JSON-RPC 2.0 三种接口。

## 启动

```bash
node dist/main.js --port 4317
```

## REST

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/tasks` | 建任务，body `{ goal, runnerType?, taskId?, metadata? }` |
| `GET` | `/tasks/:id` | 任务状态 |
| `GET` | `/tasks/:id/events` | 完整事件日志 |
| `POST` | `/tasks/:id/run` | 执行到结束，返回 `{ events, state }` |
| `GET` | `/tasks/:id/stream` | 执行结果以 SSE 返回 |
| `GET` | `/tasks/:id/approvals` | 待审批 ID 列表 |
| `POST` | `/tasks/:id/approvals` | `{ approvalId, decision: "approve" \| "reject" }` |
| `POST` | `/tasks/:id/verify` | 确定性验证 |
| `POST` | `/tasks/:id/rollback` | 回滚到最新检查点 |
| `POST` | `/tasks/:id/pause` \| `/resume` \| `/cancel` | 生命周期控制 |
| `GET` | `/tasks/:id/export` | 同步导出包 |
| `POST` | `/tasks/:id/import` | 导入同步包 |

## 事件流

```bash
curl -N http://127.0.0.1:4317/events
```

`/events` 推送运行时的全部事件，包括审批、回滚这些不经过 Runner 流的操作。桌宠和应用都订阅同一个流。

## JSON-RPC 2.0

`POST /rpc`，方法：`task.create`、`task.run`、`task.get`、`task.events`、`task.approve`、`task.reject`、`task.verify`、`task.rollback`、`task.export`。

```bash
curl -s localhost:4317/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"task.create","params":{"goal":"hello"}}'
```

## 边界

- 无 TLS、无鉴权。只适合本机监听 `127.0.0.1`。
- 没有 WebSocket：SSE 覆盖单向事件推送，命令走 POST。
