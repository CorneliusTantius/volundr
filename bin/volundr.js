#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(rootDir, "apps/server/dist/index.js");
const packageJsonPath = resolve(rootDir, "package.json");
const githubHttpRepo = "https://github.com/CorneliusTantius/volundr.git";
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

function runOrExit(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function cleanGlobalVolundrLinks() {
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", env: process.env });
  if (npmRoot.status !== 0) return;
  const globalRoot = npmRoot.stdout.trim();
  if (!globalRoot) return;
  const globalBin = resolve(globalRoot, "..", "bin");
  rmSync(join(globalBin, "volundr"), { force: true });
  rmSync(join(globalRoot, "volundr"), { force: true, recursive: true });
}

function updateVolundr(ref) {
  const tempDir = mkdtempSync(join(tmpdir(), "volundr-update-"));
  const repoDir = join(tempDir, "volundr");
  try {
    cleanGlobalVolundrLinks();
    runOrExit("git", ["clone", "--depth", "1", "--branch", ref, githubHttpRepo, repoDir]);
    runOrExit("npm", ["install"], { cwd: repoDir });
    runOrExit("npm", ["run", "build"], { cwd: repoDir });
    runOrExit("npm", ["pack"], { cwd: repoDir });
    const packed = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
    const tarball = join(repoDir, `${packed.name}-${packed.version}.tgz`);
    runOrExit("npm", ["install", "-g", tarball]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "update") {
  updateVolundr(process.argv[3] || "main");
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
