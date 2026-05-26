#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(rootDir, "apps/server/dist/index.js");
const packageJsonPath = resolve(rootDir, "package.json");
const githubRepo = "github:CorneliusTantius/volundr";
const command = process.argv[2];
const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version || "unknown";

function printHelp() {
  console.log(`völundr ${version}

Usage:
  volundr                Start web harness in current directory
  volundr help           Show help
  volundr version        Show installed version
  volundr update         Update to latest main
  volundr update <ref>   Update to tag/branch/commit
`);
}

function runChild(child) {
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "update") {
  const ref = process.argv[3] || "main";
  const child = spawn("npm", ["install", "-g", `${githubRepo}#${ref}`], {
    stdio: "inherit",
    env: process.env,
  });
  runChild(child);
} else {
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

  runChild(child);
}
