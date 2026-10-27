import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(here, "..", "renderer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

/**
 * Serves the renderer over HTTP. This is the fallback path when the Electron
 * binary is unavailable, and it is what the browser pane loads during development.
 */
export async function serveRenderer(options: { port?: number; host?: string } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = options.port ?? 4320;
  const host = options.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      const requested = url.pathname === "/" ? "/pet.html" : url.pathname;
      const resolved = path.resolve(rendererDir, `.${requested}`);
      // Keep the static server inside the renderer directory.
      if (!resolved.startsWith(rendererDir) || !existsSync(resolved)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const info = await stat(resolved);
      res.writeHead(200, {
        "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-cache"
      });
      createReadStream(resolved).pipe(res);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}/pet.html`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))))
  };
}
