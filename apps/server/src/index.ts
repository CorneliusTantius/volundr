import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_RUNTIME_KEY = "default";
const RUNTIME_IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_FILE_SUGGESTIONS = 50;
const MAX_FILE_SCAN_ENTRIES = 4000;
const MAX_FILE_SCAN_DEPTH = 8;
const SKIP_DIR_NAMES = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

type TincanStats = {
  communication: boolean;
  persona: boolean;
  piVersion: string;
  turns: number;
  promptInjects: number;
  rtk: { available: boolean; rewrites: number; commands: number; saved: number; pct: number; baselineCommands?: number; baselineSaved?: number };
  ask: { calls: number; answers: number; cancelled: number; lastQuestions: number };
  squad: { active: boolean; toolCalls: number; agentRuns: number; running: number; byAgent: Record<string, number>; lastMode: string; lastAgents: string[] };
  footer?: { input: number; output: number; total: number; cost: number; contextTokens: number; contextWindow: number; contextPct: number | null };
};

type PromptKind = "select" | "input" | "confirm";

type PromptEvent = {
  type: "volundr_prompt";
  runtimeKey: string;
  id: string;
  promptType: PromptKind;
  title: string;
  options?: string[];
  placeholder?: string;
};

type PendingPrompt = {
  id: string;
  promptType: PromptKind;
  event: PromptEvent;
  resolve: (value: string | boolean | undefined) => void;
  timer?: NodeJS.Timeout;
  abortCleanup?: () => void;
};

type RuntimeEntry = {
  key: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<ServerResponse>;
  pendingPrompts: Map<string, PendingPrompt>;
  currentPrompt?: PromptEvent;
  unsubscribe?: () => void;
  lastUsedAt: number;
  disposalTimer?: NodeJS.Timeout;
};

type WebCommand =
  | { type: "prompt"; text: string; options?: Record<string, unknown>; runtimeKey?: string }
  | { type: "steer"; text: string; runtimeKey?: string }
  | { type: "followUp"; text: string; runtimeKey?: string }
  | { type: "abort"; runtimeKey?: string }
  | { type: "newSession"; runtimeKey?: string }
  | { type: "switchSession"; path: string; runtimeKey?: string }
  | { type: "compact"; instructions?: string; runtimeKey?: string }
  | { type: "setModel"; provider: string; modelId: string; runtimeKey?: string }
  | { type: "setThinkingLevel"; level: string; runtimeKey?: string }
  | { type: "renameSession"; path: string; name: string; runtimeKey?: string }
  | { type: "deleteSession"; path: string; runtimeKey?: string }
  | { type: "promptResponse"; id: string; value: string | boolean | null; runtimeKey?: string }
  | { type: "shutdown" };

const configuredPort = parsePort(process.env.PORT ?? process.env.VOLUNDR_PORT);
const cwd = process.env.VOLUNDR_CWD ?? process.env.INIT_CWD ?? process.cwd();
const serverDir = fileURLToPath(new URL(".", import.meta.url));
const webDistDir = normalize(join(serverDir, "../../web/dist"));
const webIndexPath = join(webDistDir, "index.html");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtimes = new Map<string, RuntimeEntry>();
await ensureRuntime(DEFAULT_RUNTIME_KEY);

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const runtimeKey = normalizeRuntimeKey(url.searchParams.get("runtimeKey"));

    if (req.method === "GET" && url.pathname === "/api/health") {
      const entry = await ensureRuntime(runtimeKey);
      return json(res, { ok: true, cwd, sessionId: entry.runtime.session.sessionId, runtimeKey: entry.key });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const entry = await ensureRuntime(runtimeKey);
      return openEvents(entry, req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const entry = await ensureRuntime(runtimeKey);
      return json(res, getState(entry));
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = await SessionManager.list(cwd);
      return json(res, { sessions: attachSessionActivity(sessions), activity: getSessionActivity() });
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const entry = await ensureRuntime(runtimeKey);
      return json(res, getModelOptions(entry));
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const entry = await ensureRuntime(runtimeKey);
      return json(res, getWebStats(entry));
    }

    if (req.method === "GET" && url.pathname === "/api/messages") {
      const entry = await ensureRuntime(runtimeKey);
      const since = Number(url.searchParams.get("since"));
      const messages = entry.runtime.session.messages;
      const start = Number.isFinite(since) && since >= 0 ? Math.min(Math.trunc(since), messages.length) : 0;
      return json(res, {
        messages: messages.slice(start),
        total: messages.length,
        start,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/files") {
      const prefix = String(url.searchParams.get("prefix") ?? "");
      return json(res, { files: await getFileSuggestions(prefix) });
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      const command = await readJson(req) as WebCommand;
      const entry = await ensureRuntime(normalizeRuntimeKey("runtimeKey" in command ? command.runtimeKey : undefined));
      const result = await handleCommand(entry, command);
      return json(res, result);
    }

    if (req.method === "GET") {
      return serveWebAsset(url.pathname, res);
    }

    json(res, { error: "not_found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, { error: message }, 500);
  }
});

const port = await listenOnAvailablePort(server, configuredPort, {
  autoIncrement: process.env.PORT == null && process.env.VOLUNDR_PORT == null,
});
console.log(`völundr server listening on http://localhost:${port}`);
if (port !== configuredPort) console.log(`Port ${configuredPort} busy -> using ${port}`);
console.log(`Pi cwd: ${cwd}`);
await writeReadyFile(port);

function parsePort(value?: string) {
  const raw = value?.trim();
  if (!raw) return 8787;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

async function listenOnAvailablePort(
  server: ReturnType<typeof createServer>,
  startPort: number,
  options: { autoIncrement: boolean },
) {
  if (startPort === 0) {
    await listen(server, 0);
    return getListeningPort(server);
  }

  let port = startPort;
  while (true) {
    try {
      await listen(server, port);
      return port;
    } catch (error) {
      if (!options.autoIncrement || !isAddressInUse(error)) throw error;
      port++;
      if (port > 65535) throw new Error(`No available port found starting from ${startPort}`);
    }
  }
}

function listen(server: ReturnType<typeof createServer>, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

function isAddressInUse(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EADDRINUSE";
}

function getListeningPort(server: ReturnType<typeof createServer>) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address unavailable");
  return address.port;
}

async function writeReadyFile(port: number) {
  const readyFile = process.env.VOLUNDR_READY_FILE;
  if (!readyFile) return;
  try {
    await writeFile(readyFile, JSON.stringify({ pid: process.pid, port, cwd, startedAt: new Date().toISOString() }), "utf8");
  } catch (error) {
    console.error(`Failed to write ready file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureRuntime(key: string) {
  const existing = runtimes.get(key);
  if (existing) {
    touchRuntime(existing);
    return existing;
  }

  const sessionManager = SessionManager.create(cwd);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager,
  });

  const entry: RuntimeEntry = {
    key,
    runtime,
    clients: new Set(),
    pendingPrompts: new Map(),
    lastUsedAt: Date.now(),
  };

  runtimes.set(key, entry);
  await bindCurrentSession(entry, "boot");
  scheduleRuntimeCleanup(entry);
  return entry;
}

function normalizeRuntimeKey(value?: string | null) {
  return (value ?? DEFAULT_RUNTIME_KEY).trim() || DEFAULT_RUNTIME_KEY;
}

function touchRuntime(entry: RuntimeEntry) {
  entry.lastUsedAt = Date.now();
  scheduleRuntimeCleanup(entry);
}

function scheduleRuntimeCleanup(entry: RuntimeEntry) {
  if (entry.key === DEFAULT_RUNTIME_KEY) return;
  if (entry.runtime.session.isStreaming || entry.clients.size > 0) return;
  if (entry.disposalTimer) clearTimeout(entry.disposalTimer);
  entry.disposalTimer = setTimeout(() => {
    const current = runtimes.get(entry.key);
    if (!current) return;
    const idleFor = Date.now() - current.lastUsedAt;
    if (current.clients.size > 0 || current.runtime.session.isStreaming || idleFor < RUNTIME_IDLE_TTL_MS) {
      scheduleRuntimeCleanup(current);
      return;
    }
    void disposeRuntime(current.key);
  }, RUNTIME_IDLE_TTL_MS);
}

async function disposeRuntime(key: string) {
  const entry = runtimes.get(key);
  if (!entry || key === DEFAULT_RUNTIME_KEY) return;
  entry.unsubscribe?.();
  cancelPendingPrompts(entry);
  entry.disposalTimer && clearTimeout(entry.disposalTimer);
  for (const client of entry.clients) {
    try { client.end(); } catch {}
  }
  entry.clients.clear();
  await entry.runtime.dispose();
  runtimes.delete(key);
  broadcastAll({ type: "volundr_sessions_changed", activity: getSessionActivity() });
}

async function bindCurrentSession(entry: RuntimeEntry, reason: string) {
  entry.unsubscribe?.();
  cancelPendingPrompts(entry);
  await entry.runtime.session.bindExtensions({ uiContext: createWebUIContext(entry) });
  entry.unsubscribe = entry.runtime.session.subscribe((event) => {
    touchRuntime(entry);
    broadcast(entry, event);
    if (event && typeof event === "object" && (event as any).type && ["agent_start", "agent_end"].includes((event as any).type)) {
      broadcastAll({ type: "volundr_sessions_changed", activity: getSessionActivity() });
    }
  });
  broadcast(entry, { type: "volundr_session_bound", reason, state: getState(entry) });
  broadcastAll({ type: "volundr_sessions_changed", activity: getSessionActivity() });
}

function createWebUIContext(entry: RuntimeEntry): ExtensionUIContext {
  return {
    select(title: string, options: string[], opts?: ExtensionUIDialogOptions) {
      return requestPrompt(entry, { promptType: "select", title, options }, opts) as Promise<string | undefined>;
    },
    async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions) {
      return (await requestPrompt(entry, {
        promptType: "confirm",
        title: [title, message].filter(Boolean).join("\n\n"),
      }, opts)) === true;
    },
    input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) {
      return requestPrompt(entry, { promptType: "input", title, placeholder }, opts) as Promise<string | undefined>;
    },
    notify(message: string, notifyType: "info" | "warning" | "error" = "info") {
      broadcast(entry, { type: "volundr_notify", runtimeKey: entry.key, id: crypto.randomUUID(), notifyType, message });
    },
    onTerminalInput() { return () => {}; },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() { return undefined; },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() { return ""; },
    async editor() { return undefined; },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() { return undefined; },
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false, error: "theme control not available in web harness" }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
    get theme() { return undefined as any; },
  } as unknown as ExtensionUIContext;
}

function requestPrompt(
  entry: RuntimeEntry,
  prompt: Omit<PromptEvent, "type" | "runtimeKey" | "id">,
  opts?: { signal?: AbortSignal; timeout?: number },
) {
  if (entry.clients.size === 0) return Promise.resolve(prompt.promptType === "confirm" ? false : undefined);
  if (opts?.signal?.aborted) return Promise.resolve(prompt.promptType === "confirm" ? false : undefined);

  const id = crypto.randomUUID();
  const event: PromptEvent = { type: "volundr_prompt", runtimeKey: entry.key, id, ...prompt };

  return new Promise<string | boolean | undefined>((resolve) => {
    const pending: PendingPrompt = { id, promptType: prompt.promptType, event, resolve };

    if (opts?.timeout && opts.timeout > 0) {
      pending.timer = setTimeout(() => {
        resolvePrompt(entry, id, undefined);
      }, opts.timeout);
    }

    if (opts?.signal) {
      const onAbort = () => {
        resolvePrompt(entry, id, undefined);
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      pending.abortCleanup = () => opts.signal?.removeEventListener("abort", onAbort);
    }

    entry.pendingPrompts.set(id, pending);
    entry.currentPrompt = event;
    broadcast(entry, event);
  });
}

function resolvePrompt(entry: RuntimeEntry, id: string, value: string | boolean | undefined) {
  const pending = entry.pendingPrompts.get(id);
  if (!pending) return false;

  entry.pendingPrompts.delete(id);
  if (entry.currentPrompt?.id === id) entry.currentPrompt = undefined;
  if (pending.timer) clearTimeout(pending.timer);
  pending.abortCleanup?.();

  if (pending.promptType === "confirm") {
    pending.resolve(value === true);
  } else {
    pending.resolve(typeof value === "string" ? value : undefined);
  }

  return true;
}

function cancelPendingPrompts(entry: RuntimeEntry) {
  for (const id of [...entry.pendingPrompts.keys()]) resolvePrompt(entry, id, undefined);
}

async function handleCommand(entry: RuntimeEntry, command: WebCommand) {
  touchRuntime(entry);
  switch (command?.type) {
    case "prompt": {
      void entry.runtime.session.prompt(String(command.text ?? ""), command.options).catch((error) => reportAsyncError(entry, error));
      return { ok: true, accepted: true, runtimeKey: entry.key };
    }

    case "steer": {
      await entry.runtime.session.steer(String(command.text ?? ""));
      return { ok: true, runtimeKey: entry.key };
    }

    case "followUp": {
      await entry.runtime.session.followUp(String(command.text ?? ""));
      return { ok: true, runtimeKey: entry.key };
    }

    case "abort": {
      await entry.runtime.session.abort();
      return { ok: true, runtimeKey: entry.key };
    }

    case "newSession": {
      const nextKey = createRuntimeKey();
      const nextEntry = await ensureRuntime(nextKey);
      touchRuntime(nextEntry);
      return { ok: true, runtimeKey: nextEntry.key, state: getState(nextEntry) };
    }

    case "switchSession": {
      if (!command.path) throw new Error("switchSession requires path");
      const resolvedPath = String(command.path);
      const existing = findRuntimeBySessionFile(resolvedPath);
      if (existing) {
        touchRuntime(existing);
        return { ok: true, runtimeKey: existing.key, state: getState(existing) };
      }
      const nextKey = createRuntimeKey();
      const nextEntry = await ensureRuntime(nextKey);
      await nextEntry.runtime.switchSession(resolvedPath);
      await bindCurrentSession(nextEntry, "switchSession");
      return { ok: true, runtimeKey: nextEntry.key, state: getState(nextEntry) };
    }

    case "compact": {
      void entry.runtime.session.compact(command.instructions).catch((error) => reportAsyncError(entry, error));
      return { ok: true, accepted: true, runtimeKey: entry.key };
    }

    case "setModel": {
      const provider = String(command.provider ?? "").trim();
      const modelId = String(command.modelId ?? "").trim();
      if (!provider || !modelId) throw new Error("setModel requires provider and modelId");
      const model = entry.runtime.session.modelRegistry.find(provider, modelId);
      if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
      await entry.runtime.session.setModel(model);
      return { ok: true, runtimeKey: entry.key, state: getState(entry), models: getModelOptions(entry) };
    }

    case "setThinkingLevel": {
      const level = String(command.level ?? "").trim();
      if (!THINKING_LEVELS.includes(level as any)) throw new Error(`Invalid thinking level: ${level}`);
      entry.runtime.session.setThinkingLevel(level as any);
      return { ok: true, runtimeKey: entry.key, state: getState(entry), models: getModelOptions(entry) };
    }

    case "renameSession": {
      const path = String(command.path ?? "").trim();
      const name = String(command.name ?? "").trim();
      if (!path) throw new Error("renameSession requires path");
      if (!name) throw new Error("renameSession requires name");
      const target = findRuntimeBySessionFile(path);
      if (target) {
        target.runtime.session.sessionManager.appendSessionInfo(name);
        broadcast(target, { type: "session_info_changed", name });
        broadcastAll({ type: "volundr_sessions_changed", activity: getSessionActivity() });
      } else {
        const manager = SessionManager.open(path);
        manager.appendSessionInfo(name);
      }
      return { ok: true };
    }

    case "deleteSession": {
      const path = String(command.path ?? "").trim();
      if (!path) throw new Error("deleteSession requires path");
      const target = findRuntimeBySessionFile(path);
      if (target) {
        if (target.runtime.session.isStreaming) await target.runtime.session.abort();
        if (target.key !== DEFAULT_RUNTIME_KEY) await disposeRuntime(target.key);
      }
      await unlink(path);
      broadcastAll({ type: "volundr_sessions_changed", activity: getSessionActivity() });
      return { ok: true };
    }

    case "promptResponse": {
      const id = String(command.id ?? "").trim();
      if (!id) throw new Error("promptResponse requires id");
      const pending = entry.pendingPrompts.get(id);
      if (!pending) return { ok: true, resolved: false, runtimeKey: entry.key };
      const rawValue = command.value;
      const value = pending.promptType === "confirm"
        ? rawValue === true
        : typeof rawValue === "string"
          ? rawValue
          : undefined;
      return { ok: true, resolved: resolvePrompt(entry, id, value), runtimeKey: entry.key };
    }

    case "shutdown": {
      setTimeout(() => {
        void shutdownServer();
      }, 0);
      return { ok: true, shuttingDown: true };
    }

    default:
      throw new Error(`Unknown command: ${(command as any)?.type ?? "<missing>"}`);
  }
}

function createRuntimeKey() {
  return `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function findRuntimeBySessionFile(sessionFile: string) {
  for (const entry of runtimes.values()) {
    if (entry.runtime.session.sessionFile === sessionFile) return entry;
  }
  return undefined;
}

function getSessionActivity() {
  const activity: Record<string, { runtimeKey: string; isStreaming: boolean; hasLiveRuntime: boolean }> = {};
  for (const entry of runtimes.values()) {
    const sessionFile = entry.runtime.session.sessionFile;
    if (!sessionFile) continue;
    activity[sessionFile] = {
      runtimeKey: entry.key,
      isStreaming: entry.runtime.session.isStreaming,
      hasLiveRuntime: true,
    };
  }
  return activity;
}

function attachSessionActivity<T extends { path?: string; file?: string; sessionFile?: string }>(sessions: T[]) {
  const activity = getSessionActivity();
  return sessions.map((session) => {
    const path = session.path ?? session.file ?? session.sessionFile;
    return path && activity[path] ? { ...session, ...activity[path] } : session;
  });
}

function getState(entry: RuntimeEntry) {
  const session = entry.runtime.session;
  return {
    cwd,
    runtimeKey: entry.key,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    isStreaming: session.isStreaming,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    model: session.model,
    messageCount: session.messages.length,
  };
}

function getModelOptions(entry: RuntimeEntry) {
  const session = entry.runtime.session;
  const currentModel = session.model;
  return {
    runtimeKey: entry.key,
    current: currentModel ? {
      provider: currentModel.provider,
      modelId: currentModel.id,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
    } : undefined,
    models: session.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      supportsThinking: !!model.reasoning,
    })),
    thinkingLevels: THINKING_LEVELS,
  };
}

async function getFileSuggestions(prefix: string) {
  const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/^\.?\//, "");
  const slashIndex = normalizedPrefix.lastIndexOf("/");
  const dirPrefix = slashIndex >= 0 ? normalizedPrefix.slice(0, slashIndex + 1) : "";
  const partial = slashIndex >= 0 ? normalizedPrefix.slice(slashIndex + 1) : normalizedPrefix;
  const targetDir = resolve(cwd, dirPrefix || ".");

  if (!isPathInsideCwd(targetDir)) return [];

  const direct = await listDirectSuggestions(targetDir, dirPrefix, partial);
  if (!normalizedPrefix) return direct;

  const recursive = await listRecursiveSuggestions(targetDir, dirPrefix, normalizedPrefix, partial);
  return dedupeSuggestions([...direct, ...recursive]).slice(0, MAX_FILE_SUGGESTIONS);
}

async function listDirectSuggestions(targetDir: string, dirPrefix: string, partial: string) {
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const query = partial.toLowerCase();
  return entries
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .sort((a, b) => compareSuggestions({
      name: a.name,
      path: `${dirPrefix}${a.name}${a.isDirectory() ? "/" : ""}`,
      isDirectory: a.isDirectory(),
    }, {
      name: b.name,
      path: `${dirPrefix}${b.name}${b.isDirectory() ? "/" : ""}`,
      isDirectory: b.isDirectory(),
    }, dirPrefix ? `${dirPrefix}${partial}` : partial, partial))
    .slice(0, MAX_FILE_SUGGESTIONS)
    .map((entry) => ({
      name: entry.name,
      path: `${dirPrefix}${entry.name}${entry.isDirectory() ? "/" : ""}`,
      isDirectory: entry.isDirectory(),
    }));
}

async function listRecursiveSuggestions(targetDir: string, dirPrefix: string, query: string, partial: string) {
  const suggestions: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  const queue: Array<{ dir: string; prefix: string; depth: number }> = [{ dir: targetDir, prefix: dirPrefix, depth: 0 }];
  const seen = new Set<string>();
  const queryLower = query.toLowerCase();
  const partialLower = partial.toLowerCase();
  let scanned = 0;

  while (queue.length && scanned < MAX_FILE_SCAN_ENTRIES && suggestions.length < MAX_FILE_SUGGESTIONS * 3) {
    const current = queue.shift();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      scanned++;
      const entryPath = `${current.prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      const entryPathLower = entryPath.toLowerCase();
      const basenameLower = entry.name.toLowerCase();

      if (!seen.has(entryPath) && (entryPathLower.includes(queryLower) || (!!partialLower && basenameLower.includes(partialLower)))) {
        suggestions.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        });
        seen.add(entryPath);
      }

      if (
        entry.isDirectory()
        && current.depth < MAX_FILE_SCAN_DEPTH
        && scanned < MAX_FILE_SCAN_ENTRIES
        && !SKIP_DIR_NAMES.has(entry.name)
      ) {
        queue.push({
          dir: resolve(current.dir, entry.name),
          prefix: `${current.prefix}${entry.name}/`,
          depth: current.depth + 1,
        });
      }
    }
  }

  return suggestions
    .sort((a, b) => compareSuggestions(a, b, query, partial))
    .slice(0, MAX_FILE_SUGGESTIONS);
}

function compareSuggestions(
  a: { name: string; path: string; isDirectory: boolean },
  b: { name: string; path: string; isDirectory: boolean },
  query: string,
  partial: string,
) {
  const scoreA = rankSuggestion(a, query, partial);
  const scoreB = rankSuggestion(b, query, partial);
  if (scoreA !== scoreB) return scoreB - scoreA;
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.localeCompare(b.path);
}

function rankSuggestion(
  suggestion: { name: string; path: string; isDirectory: boolean },
  query: string,
  partial: string,
) {
  const path = suggestion.path.toLowerCase();
  const name = suggestion.name.toLowerCase();
  const queryLower = query.toLowerCase();
  const partialLower = partial.toLowerCase();

  let score = 0;
  if (queryLower && path.startsWith(queryLower)) score += 120;
  if (partialLower && name.startsWith(partialLower)) score += 80;
  if (partialLower && path.includes(`/${partialLower}`)) score += 40;
  if (queryLower && path.includes(queryLower)) score += 30;
  if (suggestion.isDirectory) score += 10;
  return score;
}

function dedupeSuggestions(suggestions: Array<{ name: string; path: string; isDirectory: boolean }>) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.path)) return false;
    seen.add(suggestion.path);
    return true;
  });
}

function isPathInsideCwd(path: string) {
  const rel = relative(cwd, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !rel.includes(`${sep}..${sep}`));
}

function getTincanStatus(): TincanStats | undefined {
  return (globalThis as any).__piTincan as TincanStats | undefined;
}

function getWebStats(entry: RuntimeEntry) {
  const session = entry.runtime.session;
  const stats = session.getSessionStats();
  const ctx = stats.contextUsage;
  const tincan = getTincanStatus();
  const sessionRtkCommands = tincan ? Math.max(0, tincan.rtk.commands - (tincan.rtk.baselineCommands ?? 0)) : 0;
  const sessionRtkSaved = tincan ? Math.max(0, tincan.rtk.saved - (tincan.rtk.baselineSaved ?? 0)) : 0;
  return {
    runtimeKey: entry.key,
    session: {
      messages: stats.totalMessages,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      totalTokens: stats.tokens.total,
      cost: stats.cost,
      contextTokens: ctx?.tokens ?? 0,
      contextWindow: ctx?.contextWindow ?? 0,
      contextPct: ctx?.percent ?? null,
    },
    tincan: tincan ? {
      communication: tincan.communication,
      persona: tincan.persona,
      piVersion: tincan.piVersion,
      turns: tincan.turns,
      promptInjects: tincan.promptInjects,
      rtk: {
        available: tincan.rtk.available,
        rewrites: tincan.rtk.rewrites,
        commands: sessionRtkCommands,
        saved: sessionRtkSaved,
        pct: tincan.rtk.pct,
      },
      ask: tincan.ask,
      squad: {
        active: tincan.squad.active,
        toolCalls: tincan.squad.toolCalls,
        agentRuns: tincan.squad.agentRuns,
        running: tincan.squad.running,
        lastMode: tincan.squad.lastMode,
        lastAgents: tincan.squad.lastAgents,
        topAgents: Object.entries(tincan.squad.byAgent ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
      },
    } : null,
  };
}

function openEvents(entry: RuntimeEntry, req: IncomingMessage, res: ServerResponse) {
  touchRuntime(entry);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  entry.clients.add(res);
  sendEvent(res, { type: "volundr_connected", state: getState(entry) });
  if (entry.currentPrompt) sendEvent(res, entry.currentPrompt);

  const keepAlive = setInterval(() => res.write(`: keepalive\n\n`), 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    entry.clients.delete(res);
    touchRuntime(entry);
    scheduleRuntimeCleanup(entry);
  });
}

function broadcast(entry: RuntimeEntry, event: unknown) {
  for (const client of entry.clients) sendEvent(client, event);
}

function broadcastAll(event: unknown) {
  for (const entry of runtimes.values()) {
    for (const client of entry.clients) sendEvent(client, event);
  }
}

function sendEvent(res: ServerResponse, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function reportAsyncError(entry: RuntimeEntry, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  broadcast(entry, { type: "volundr_error", message });
}

function serveWebAsset(pathname: string, res: ServerResponse) {
  if (!existsSync(webIndexPath)) {
    return json(res, { error: "web_build_missing", message: "Build web app first with npm run build" }, 503);
  }

  const safePath = pathname === "/" ? "/index.html" : pathname;
  const assetPath = normalize(join(webDistDir, safePath));
  const isInsideWebDist = assetPath.startsWith(webDistDir);
  const targetPath = isInsideWebDist && existsSync(assetPath) ? assetPath : webIndexPath;
  const ext = extname(targetPath);
  const body = readFileSync(targetPath);
  res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
  res.end(body);
}

async function shutdownServer() {
  for (const entry of runtimes.values()) {
    entry.unsubscribe?.();
    cancelPendingPrompts(entry);
    entry.disposalTimer && clearTimeout(entry.disposalTimer);
    await entry.runtime.dispose();
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", async () => {
  await shutdownServer();
});

process.on("SIGTERM", async () => {
  await shutdownServer();
});
