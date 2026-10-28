import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { RuntimeEvent } from "@agent/protocol";
import type { RunnerType } from "@agent/protocol";
import { RuntimeHost } from "./runtime-host.js";
import { SecretStore } from "./secrets.js";
import { SettingsStore, type AppSettings } from "./settings.js";

const storageDir = path.join(app.getPath("userData"), "runtime");
const settings = new SettingsStore(path.join(storageDir, "settings.json"));
const secrets = new SecretStore(storageDir);

let window: BrowserWindow | undefined;

function send(channel: string, payload: unknown): void {
  if (window !== undefined && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

const host = new RuntimeHost({
  storageDir,
  secretFor: (provider) => secrets.get(provider === "anthropic" ? "anthropic-api-key" : "openai-api-key"),
  emit: (event: RuntimeEvent) => send("runtime:event", event)
});

function bootRuntime(current: AppSettings): { provider: string; model: string; live: boolean; reason: string } {
  return host.configure(current);
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    title: "Agent",
    backgroundColor: "#faf9f5",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  void created.loadFile(path.join(import.meta.dirname, "..", "renderer", "index.html"));
  created.on("closed", () => {
    window = undefined;
  });
  return created;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: () => send("ui:open-settings", null) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "New Conversation", accelerator: "Cmd+N", click: () => send("ui:new-conversation", null) },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open Storage Folder",
          click: () => {
            void shell.openPath(storageDir);
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- IPC: settings ---------------- */

ipcMain.handle("settings:get", () => {
  const current = settings.get();
  return {
    ...current,
    hasOpenAIKey: secrets.has("openai-api-key"),
    hasAnthropicKey: secrets.has("anthropic-api-key")
  };
});

ipcMain.handle("settings:update", (_event, patch: Partial<AppSettings>) => {
  const updated = settings.update(patch);
  // Rebuilding picks up model, workspace, pricing and approval policy changes.
  const provider = bootRuntime(updated);
  send("runtime:provider", provider);
  return { settings: updated, provider };
});

ipcMain.handle("settings:set-key", (_event, kind: "openai" | "anthropic", value: string) => {
  secrets.set(kind === "anthropic" ? "anthropic-api-key" : "openai-api-key", value);
  const provider = bootRuntime(settings.get());
  send("runtime:provider", provider);
  return { hasKey: secrets.has(kind === "anthropic" ? "anthropic-api-key" : "openai-api-key"), provider };
});

ipcMain.handle("settings:pick-workspace", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose the folder the agent may work in"
  });
  if (result.canceled || result.filePaths[0] === undefined) {
    return { canceled: true };
  }
  const updated = settings.update({ workspaceRoot: result.filePaths[0] });
  bootRuntime(updated);
  return { canceled: false, workspaceRoot: updated.workspaceRoot };
});

/* ---------------- IPC: runtime ---------------- */

ipcMain.handle("runtime:provider", () => host.listTasks());

ipcMain.handle("runtime:tasks", () => host.listTasks());

ipcMain.handle("runtime:task", (_event, taskId: string) => host.getTask(taskId));

ipcMain.handle("runtime:events", (_event, taskId: string) => host.getEvents(taskId));

ipcMain.handle("runtime:delete", (_event, taskId: string) => host.deleteTask(taskId));

ipcMain.handle("runtime:run", (_event, goal: string, images: readonly { mediaType: string; data: string }[], runnerType?: RunnerType) => host.createAndRun(goal, images ?? [], runnerType));

ipcMain.handle("runtime:send", (_event, taskId: string, text: string, images: readonly { mediaType: string; data: string }[]) => host.sendMessage(taskId, text, images ?? []));

ipcMain.handle("runtime:approvals", (_event, taskId: string) => host.pendingApprovals(taskId));

ipcMain.handle("runtime:approve", (_event, taskId: string, approvalId: string, decision: "approve" | "reject") => {
  host.approve(taskId, approvalId, decision);
  return { ok: true };
});

ipcMain.handle("runtime:rollback", async (_event, taskId: string) => {
  await host.rollback(taskId);
  return { ok: true };
});

ipcMain.handle("runtime:cancel", async (_event, taskId: string) => {
  await host.cancel(taskId);
  return { ok: true };
});

ipcMain.handle("runtime:verify", (_event, taskId: string) => host.verify(taskId));

ipcMain.handle("runtime:tools", () => host.tools());

ipcMain.handle("runtime:models", () => host.listModels());

ipcMain.handle("memory:search", (_event, query: string) => host.searchMemory(query));

ipcMain.handle("memory:list", (_event, scope?: "global" | "project" | "task" | "session") => host.listMemory(scope));

ipcMain.handle("memory:update", (_event, memoryId: string, content: string, expectedVersion: number) => host.updateMemory(memoryId, content, expectedVersion));

ipcMain.handle("memory:add", (_event, key: string, content: string, scope: "global" | "project" | "task" | "session") => {
  host.addMemory(key, content, scope);
  return { ok: true };
});

ipcMain.handle("memory:delete", (_event, memoryId: string) => {
  host.deleteMemory(memoryId);
  return { ok: true };
});

ipcMain.handle("app:open-storage", () => shell.openPath(storageDir));

// Sync moves a bundle between machines through a file the user picks, so no
// server or account is involved.
ipcMain.handle("sync:export", async () => {
  const result = host.exportEverything();
  const target = await dialog.showSaveDialog({
    title: "Export tasks and memory",
    defaultPath: `agent-profile-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "Agent bundle", extensions: ["json"] }]
  });
  if (target.canceled || target.filePath === undefined) {
    return { cancelled: true };
  }
  await writeFile(target.filePath, JSON.stringify(result.bundle, null, 2), "utf8");
  return { cancelled: false, path: target.filePath, tasks: result.tasks, memories: result.memories };
});

ipcMain.handle("sync:import", async () => {
  const picked = await dialog.showOpenDialog({
    title: "Import tasks and memory",
    properties: ["openFile"],
    filters: [{ name: "Agent bundle", extensions: ["json"] }]
  });
  const file = picked.filePaths[0];
  if (picked.canceled || file === undefined) {
    return { cancelled: true };
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as { records?: readonly unknown[] };
  const summary = host.importEverything(parsed);
  return { cancelled: false, ...summary };
});

/* ---------------- lifecycle ---------------- */

app.whenReady().then(() => {
  const provider = bootRuntime(settings.get());
  buildMenu();
  window = createWindow();
  window.webContents.once("did-finish-load", () => send("runtime:provider", provider));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  host.dispose();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => host.dispose());
