/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- preload runs in Electron's CommonJS sandbox */
// Preload runs in an isolated world: it exposes a narrow API and nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    setKey: (kind, value) => ipcRenderer.invoke("settings:set-key", kind, value),
    pickWorkspace: () => ipcRenderer.invoke("settings:pick-workspace")
  },
  runtime: {
    tasks: () => ipcRenderer.invoke("runtime:tasks"),
    task: (taskId) => ipcRenderer.invoke("runtime:task", taskId),
    events: (taskId) => ipcRenderer.invoke("runtime:events", taskId),
    remove: (taskId) => ipcRenderer.invoke("runtime:delete", taskId),
    run: (goal, images, runnerType) => ipcRenderer.invoke("runtime:run", goal, images ?? [], runnerType),
    send: (taskId, text, images) => ipcRenderer.invoke("runtime:send", taskId, text, images ?? []),
    approvals: (taskId) => ipcRenderer.invoke("runtime:approvals", taskId),
    approve: (taskId, approvalId, decision) => ipcRenderer.invoke("runtime:approve", taskId, approvalId, decision),
    rollback: (taskId) => ipcRenderer.invoke("runtime:rollback", taskId),
    cancel: (taskId) => ipcRenderer.invoke("runtime:cancel", taskId),
    verify: (taskId) => ipcRenderer.invoke("runtime:verify", taskId),
    tools: () => ipcRenderer.invoke("runtime:tools"),
    models: () => ipcRenderer.invoke("runtime:models"),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("runtime:event", handler);
      return () => ipcRenderer.removeListener("runtime:event", handler);
    },
    onProvider: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("runtime:provider", handler);
      return () => ipcRenderer.removeListener("runtime:provider", handler);
    }
  },
  sync: {
    export: () => ipcRenderer.invoke("sync:export"),
    import: () => ipcRenderer.invoke("sync:import")
  },
  memory: {
    search: (query) => ipcRenderer.invoke("memory:search", query),
    list: (scope) => ipcRenderer.invoke("memory:list", scope),
    update: (memoryId, content, expectedVersion) => ipcRenderer.invoke("memory:update", memoryId, content, expectedVersion),
    add: (key, content, scope) => ipcRenderer.invoke("memory:add", key, content, scope),
    delete: (memoryId) => ipcRenderer.invoke("memory:delete", memoryId)
  },
  ui: {
    onOpenSettings: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("ui:open-settings", handler);
      return () => ipcRenderer.removeListener("ui:open-settings", handler);
    },
    onNewConversation: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("ui:new-conversation", handler);
      return () => ipcRenderer.removeListener("ui:new-conversation", handler);
    },
    openStorage: () => ipcRenderer.invoke("app:open-storage")
  }
});
