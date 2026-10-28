// The preload must be CommonJS with an explicit .cjs extension, so it is copied
// beside the compiled main process instead of being built by tsc.
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await copyFile(path.join(here, "..", "src", "preload.cjs"), path.join(here, "..", "dist", "preload.cjs"));
