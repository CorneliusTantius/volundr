#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(rootDir, "apps/server/dist/index.js");
const packageJsonPath = resolve(rootDir, "package.json");
const githubHttpRepo = "https://github.com/CorneliusTantius/volundr.git";
const command = process.argv[2];
const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version || "unknown";
const registryDir = resolve(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "volundr");
const registryPath = join(registryDir, "servers.json");

function printHelp() {
  console.log(`völundr ${version}

Usage:
  volundr                Start web harness in current directory (background)
  volundr help           Show help
  volundr version        Show installed version
  volundr update         Update to latest main
  volundr update <ref>   Update to tag/branch/commit
  volundr status         List active servers
  volundr stop <id>      Stop server by id
  volundr restart <id>   Restart server by id

Port:
  default = 8787
  if 8787 busy, auto-increments to next free port
  set fixed port with PORT or VOLUNDR_PORT
  set random port with PORT=0 volundr
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
  const npmPrefix = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", env: process.env });
  if (npmRoot.status !== 0) return;
  const globalRoot = npmRoot.stdout.trim();
  const globalPrefix = npmPrefix.status === 0 ? npmPrefix.stdout.trim() : "";
  if (!globalRoot) return;
  const globalBin = process.platform === "win32" ? globalPrefix : resolve(globalRoot, "..", "bin");
  if (globalBin) {
    rmSync(join(globalBin, "volundr"), { force: true });
    rmSync(join(globalBin, "volundr.cmd"), { force: true });
    rmSync(join(globalBin, "volundr.ps1"), { force: true });
  }
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

function ensureRegistryDir() {
  mkdirSync(registryDir, { recursive: true });
}

function readRegistry() {
  ensureRegistryDir();
  if (!existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  ensureRegistryDir();
  writeFileSync(registryPath, JSON.stringify(entries, null, 2), "utf8");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupRegistry() {
  const next = readRegistry().filter((entry) => entry?.pid && processAlive(entry.pid));
  writeRegistry(next);
  return next;
}

function getNextId(entries) {
  return entries.reduce((max, entry) => Math.max(max, Number(entry?.id) || 0), 0) + 1;
}

function printStatus(entries) {
  if (!entries.length) {
    console.log("No active völundr servers.");
    return;
  }
  console.log("ID  PID     PORT   URL                     CWD");
  for (const entry of entries) {
    console.log(
      `${String(entry.id).padEnd(3)} ${String(entry.pid).padEnd(7)} ${String(entry.port).padEnd(6)} ${String(entry.url).padEnd(23)} ${entry.cwd}`,
    );
  }
}

function waitForReadyFile(filePath, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, "utf8"));
      } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return undefined;
}

function startServer({ cwd, port, restartOf } = {}) {
  if (!existsSync(serverEntry)) {
    console.error("volundr: build artifacts missing. Run `npm run build` before using packaged CLI.");
    process.exit(1);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "volundr-ready-"));
  const readyFile = join(tempDir, "ready.json");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      VOLUNDR_CWD: cwd || process.cwd(),
      ...(port != null ? { VOLUNDR_PORT: String(port) } : {}),
      VOLUNDR_READY_FILE: readyFile,
    },
  });

  child.unref();

  const ready = waitForReadyFile(readyFile);
  rmSync(tempDir, { recursive: true, force: true });

  if (!ready?.port) {
    console.error("volundr: server started but did not report ready state in time.");
    process.exit(1);
  }

  const entries = cleanupRegistry();
  const id = restartOf?.id ?? getNextId(entries);
  const entry = {
    id,
    pid: ready.pid || child.pid,
    port: ready.port,
    url: `http://localhost:${ready.port}`,
    cwd: ready.cwd || (cwd || process.cwd()),
    startedAt: ready.startedAt || new Date().toISOString(),
  };
  const next = restartOf ? [...entries.filter((item) => item.id !== restartOf.id), entry] : [...entries, entry];
  writeRegistry(next);

  console.log(`völundr started [${entry.id}] ${entry.url}`);
  console.log(`pid: ${entry.pid}`);
  console.log(`cwd: ${entry.cwd}`);
}

function findServer(id) {
  const entries = cleanupRegistry();
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    console.error(`Invalid server id: ${id}`);
    process.exit(1);
  }
  const entry = entries.find((item) => item.id === numericId);
  if (!entry) {
    console.error(`Server not found: ${id}`);
    process.exit(1);
  }
  return { entry, entries };
}

function stopServer(id) {
  const { entry, entries } = findServer(id);
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch {}
  writeRegistry(entries.filter((item) => item.id !== entry.id));
  console.log(`stopped [${entry.id}] pid=${entry.pid} port=${entry.port}`);
}

function restartServer(id) {
  const { entry, entries } = findServer(id);
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch {}
  writeRegistry(entries.filter((item) => item.id !== entry.id));
  startServer({ cwd: entry.cwd, port: entry.port, restartOf: entry });
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "update") {
  updateVolundr(process.argv[3] || "main");
} else if (command === "status") {
  printStatus(cleanupRegistry());
} else if (command === "stop") {
  stopServer(process.argv[3]);
} else if (command === "restart") {
  restartServer(process.argv[3]);
} else if (command === undefined) {
  startServer();
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
