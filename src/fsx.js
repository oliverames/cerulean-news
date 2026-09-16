// Indirection over the handful of file reads and writes the generator makes,
// so the same pipeline runs on Node (the CLI, the tests) and inside a
// Cloudflare Worker, which has no filesystem.
//
// The generator addresses its state by path throughout ("site/feed.json",
// "data/media-tracker-seed.json"). Rather than thread a storage object through
// six modules and rewrite the tests that call them directly, the Worker swaps
// the two primitives below for R2-backed equivalents and keeps the paths as
// opaque keys. Node behaviour is the default, so nothing changes for the CLI.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const nodeFileSystem = {
  async readText(filePath) {
    return readFile(filePath, "utf8");
  },
  async writeText(filePath, contents) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  },
};

let impl = nodeFileSystem;

// Replaces the active implementation. The Worker calls this once at startup;
// tests that need the real filesystem back call resetFileSystem().
export function setFileSystem(next) {
  impl = { ...nodeFileSystem, ...next };
}

export function resetFileSystem() {
  impl = nodeFileSystem;
}

// Reads UTF-8 text. Rejects the way fs does when the path is absent, because
// every caller already distinguishes "missing" from "malformed" by catching.
export function readText(filePath) {
  return impl.readText(filePath);
}

export function writeText(filePath, contents) {
  return impl.writeText(filePath, contents);
}
