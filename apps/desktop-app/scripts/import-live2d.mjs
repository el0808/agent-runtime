#!/usr/bin/env node
// Copies the Live2D model and browser runtime into renderer/ so the app can load
// them. Assets stay out of git: they are large and separately licensed.
//
//   node scripts/import-live2d.mjs [--source <open-yachiyo dir>] [--force]

import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const renderer = path.join(appRoot, "renderer");
const modelsDir = path.join(renderer, "models");
const bundlePath = path.join(renderer, "live2d-bundle.js");

const MODEL_SOURCE = path.join("assets", "live2d", "yachiyo-kaguya");

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function findModelSource() {
  const explicit = flag("--source", process.env.OPEN_YACHIYO_DIR);
  const candidates = [
    explicit,
    path.resolve(appRoot, "..", "..", "..", "open-yachiyo"),
    path.resolve(process.env.HOME ?? "", "open-yachiyo"),
    path.resolve(process.env.HOME ?? "", "Desktop", "open-yachiyo"),
    path.resolve(process.env.HOME ?? "", "Downloads", "open-yachiyo"),
    "/tmp/oy-check"
  ].filter(Boolean);

  for (const candidate of candidates) {
    const modelDir = path.join(candidate, MODEL_SOURCE);
    if (existsSync(modelDir)) return modelDir;
  }
  return undefined;
}

async function findRuntimeFile(names) {
  const roots = [
    appRoot,
    path.resolve(appRoot, "..", ".."),
    path.resolve(process.env.LIVE2D_RUNTIME_DIR ?? process.env.OPEN_YACHIYO_DIR ?? "/tmp/l2drt")
  ];
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, "node_modules", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function importModel() {
  const source = await findModelSource();
  if (source === undefined) {
    console.error("Model not found.");
    console.error("Pass --source <path-to-open-yachiyo> or set OPEN_YACHIYO_DIR.");
    return false;
  }
  const target = path.join(modelsDir, "yachiyo-kaguya");
  const info = await stat(source);
  if (!info.isDirectory()) {
    console.error(`${source} is not a directory`);
    return false;
  }
  await mkdir(modelsDir, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  const files = await readdir(target);
  console.log(`model copied (${files.length} entries) -> ${path.relative(appRoot, target)}`);
  return true;
}

async function importRuntime() {
  const pixi = await findRuntimeFile([
    "pixi.js/dist/browser/pixi.min.js",
    "pixi.js/dist/pixi.min.js",
    "pixi.js/dist/pixi.js"
  ]);
  const cubism = await findRuntimeFile([
    "pixi-live2d-display/dist/cubism4.min.js",
    "pixi-live2d-display/dist/cubism4.js"
  ]);
  if (pixi === undefined || cubism === undefined) {
    console.warn("Live2D runtime not bundled: pixi.js or pixi-live2d-display missing.");
    console.warn("Install them in the open-yachiyo checkout, or run:");
    console.warn("  npm i pixi.js@6 pixi-live2d-display@0.4");
    console.warn("The app still runs with the drawn fallback character.");
    return false;
  }
  const pixiSource = await import("node:fs/promises").then((fs) => fs.readFile(pixi, "utf8"));
  const cubismSource = await import("node:fs/promises").then((fs) => fs.readFile(cubism, "utf8"));
  const banner = "/* pixi.js + pixi-live2d-display (cubism4), concatenated by import-live2d.mjs */\n";
  await writeFile(bundlePath, `${banner}${pixiSource}\n${cubismSource}\n`, "utf8");
  console.log(`runtime bundled -> ${path.relative(appRoot, bundlePath)}`);
  return true;
}

const modelOk = await importModel();
const runtimeOk = await importRuntime();
process.exitCode = modelOk && runtimeOk ? 0 : 1;
