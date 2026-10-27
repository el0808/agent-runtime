import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveRenderer } from "./serve.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface ElectronModule {
  readonly app: { whenReady(): Promise<void>; on(event: string, handler: () => void): void; quit(): void };
  readonly BrowserWindow: new (options: Record<string, unknown>) => {
    loadFile(file: string, options?: Record<string, unknown>): Promise<void>;
    on(event: string, handler: () => void): void;
  };
}

async function loadElectron(): Promise<ElectronModule | undefined> {
  try {
    // Electron is optional: the browser renderer works without it and the
    // install is skipped when the binary cannot be downloaded.
    const module = await import("electron" as string);
    const candidate = (module as { default?: ElectronModule }).default ?? (module as unknown as ElectronModule);
    return typeof candidate?.app?.whenReady === "function" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const gateway = process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:4317";
  const electron = await loadElectron();

  if (electron !== undefined) {
    await electron.app.whenReady();
    const window = new electron.BrowserWindow({
      width: 460,
      height: 560,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await window.loadFile(path.resolve(here, "..", "renderer", "pet.html"), { query: { gateway } });
    electron.app.on("window-all-closed", () => electron.app.quit());
    process.stdout.write("desktop-pet running in Electron\n");
    return;
  }

  const server = await serveRenderer({ port: Number(process.env.AGENT_PET_PORT ?? "4320") });
  const target = `${server.url}?gateway=${encodeURIComponent(gateway)}`;
  process.stdout.write(`Electron unavailable; serving the renderer instead.\n`);
  process.stdout.write(`  open ${target}\n`);
  process.stdout.write(`  open ${target}&demo=1   (scripted states, no gateway needed)\n`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
