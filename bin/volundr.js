#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(rootDir, "apps/server/dist/index.js");

if (!existsSync(serverEntry)) {
  console.error("volundr: build artifacts missing. Run `npm run build` before using packaged CLI.");
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    VOLUNDR_CWD: process.cwd(),
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
