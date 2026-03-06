import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const publicDir = path.join(rootDir, "public");

const entryPoints = {
  background: path.join(rootDir, "src", "background.js"),
  content: path.join(rootDir, "src", "content.js"),
  popup: path.join(rootDir, "src", "popup.js"),
  offscreen: path.join(rootDir, "src", "offscreen.js"),
  "audio-worklet": path.join(rootDir, "src", "audio-worklet.js")
};

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints,
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: distDir,
  entryNames: "[name]",
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": "\"production\"",
    global: "globalThis"
  }
});

await cp(publicDir, distDir, { recursive: true });

const files = await readdir(distDir);
console.log(`Built extension into ${distDir} (${files.length} top-level files).`);
