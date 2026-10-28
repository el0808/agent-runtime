import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rendererDir = path.resolve(here, "..", "renderer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".moc3": "application/octet-stream",
  ".mp3": "audio/mpeg"
};

export interface RendererServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Serves the renderer plus imported model assets, and proxies `/api/*` to the
 * gateway. Same-origin keeps fetch and EventSource free of CORS handling.
 */
/** Real port, resolving 0 to whatever the OS assigned. */
function boundPort(server: { address(): unknown }, fallback: number): number {
  const address = server.address();
  if (typeof address === "object" && address !== null && "port" in address) {
    return Number((address as { port: number }).port);
  }
  return fallback;
}

export async function serveApp(options: { port?: number; host?: string; assetsDir?: string; gateway?: string } = {}): Promise<RendererServer> {
  const port = options.port ?? 4321;
  const host = options.host ?? "127.0.0.1";
  const modelsDir = options.assetsDir ?? path.join(rendererDir, "models");
  const gateway = (options.gateway ?? "http://127.0.0.1:4317").replace(/\/+$/, "");

  const roots: ReadonlyArray<{ prefix: string; dir: string }> = [
    { prefix: "/models/", dir: modelsDir },
    { prefix: "/", dir: rendererDir }
  ];

  const proxy = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const target = `${gateway}${url.pathname.slice("/api".length)}${url.search}`;
    const headers: Record<string, string> = { accept: "text/event-stream, application/json" };
    if (req.headers["content-type"] !== undefined) {
      headers["content-type"] = String(req.headers["content-type"]);
    }
    let response: Response;
    try {
      response = await fetch(target, {
        method: req.method ?? "GET",
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
      });
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `gateway unreachable: ${error instanceof Error ? error.message : String(error)}` }));
      return;
    }
    res.writeHead(response.status, {
      "content-type": String(response.headers.get("content-type") ?? "application/json"),
      "cache-control": "no-cache",
      ...(response.headers.get("content-type")?.includes("event-stream") === true ? { connection: "keep-alive" } : {})
    });
    if (response.body === null) {
      res.end();
      return;
    }
    req.on("close", () => {
      // Client went away: release the upstream stream.
      void response.body?.cancel().catch(() => undefined);
    });
    try {
      for await (const chunk of response.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    } catch {
      // Upstream aborted (task cancelled, gateway restarted).
    }
    res.end();
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await proxy(req, res, url);
        return;
      }

      // pathname stays percent-encoded; model files have non-ASCII names.
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad path encoding");
        return;
      }
      const requestPath = decoded === "/" ? "/index.html" : decoded;

      for (const root of roots) {
        if (!requestPath.startsWith(root.prefix)) {
          continue;
        }
        const relative = requestPath.slice(root.prefix.length);
        const resolved = path.resolve(root.dir, relative);
        // Never serve outside the mounted directory.
        if (resolved !== root.dir && !resolved.startsWith(`${root.dir}${path.sep}`)) {
          continue;
        }
        if (!existsSync(resolved)) {
          continue;
        }
        const info = await stat(resolved);
        if (!info.isFile()) {
          continue;
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
          "content-length": info.size,
          "cache-control": "no-cache",
          // The Live2D runtime is fetched from the vendor CDN; everything else is local.
          "content-security-policy": [
            "default-src 'self'",
            "script-src 'self' https://cubism.live2d.com 'unsafe-inline' 'unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "connect-src 'self'",
            "worker-src 'self' blob:"
          ].join("; ")
        });
        createReadStream(resolved).pipe(res);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${requestPath}`);
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
    url: `http://${host}:${boundPort(server, port)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))))
  };
}
