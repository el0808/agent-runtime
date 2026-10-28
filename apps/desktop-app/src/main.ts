import { serveApp } from "./serve.js";

interface ElectronModule {
  readonly app: { whenReady(): Promise<void>; on(event: string, handler: () => void): void; quit(): void };
  readonly BrowserWindow: new (options: Record<string, unknown>) => {
    loadURL(url: string): Promise<void>;
    on(event: string, handler: () => void): void;
  };
}

async function loadElectron(): Promise<ElectronModule | undefined> {
  try {
    // Electron is optional: the same renderer runs in a browser.
    const module = await import("electron" as string);
    const candidate = (module as { default?: ElectronModule }).default ?? (module as unknown as ElectronModule);
    return typeof candidate?.app?.whenReady === "function" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1]) : fallback;
}

async function main(): Promise<void> {
  const gateway = flag("--gateway", process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:4317");
  const port = Number(flag("--port", process.env.AGENT_APP_PORT ?? "4321"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${port}\n`);
    process.exitCode = 2;
    return;
  }

  // The page is served over HTTP so fetch and EventSource have a real origin.
  const server = await serveApp({ port, gateway });
  // Same-origin now: the renderer calls /api and never needs the gateway URL.
  const appUrl = `${server.url}/index.html`;
  const petUrl = `${server.url}/pet.html`;

  const electron = await loadElectron();
  if (electron !== undefined) {
    await electron.app.whenReady();
    const window = new electron.BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1000,
      minHeight: 620,
      backgroundColor: "#0d1017",
      title: "Agent Runtime",
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await window.loadURL(appUrl);
    const pet = new electron.BrowserWindow({
      width: 420,
      height: 560,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await pet.loadURL(petUrl);
    electron.app.on("window-all-closed", () => electron.app.quit());
    process.stdout.write(`desktop app open (Electron) — gateway ${gateway}\n`);
    return;
  }

  process.stdout.write(`Electron unavailable; open these in a browser:\n`);
  process.stdout.write(`  app  ${appUrl}\n`);
  process.stdout.write(`  pet  ${petUrl}\n`);
  process.stdout.write(`gateway must be running: node apps/gateway/dist/main.js\n`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
