import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_RUNTIME_KEY = "default";
const RUNTIME_IDLE_TTL_MS = 15 * 60 * 1000;

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

type RuntimeEntry = {
  key: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<ServerResponse>;
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
  | { type: "setThinkingLevel"; level: string; runtimeKey?: string };

const port = Number(process.env.PORT ?? 8787);
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

    if (req.method === "POST" && url.pathname === "/api/command") {
      const command = await readJson(req) as WebCommand;
      const entry = await ensureRuntime(normalizeRuntimeKey(command.runtimeKey));
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

server.listen(port, () => {
  console.log(`völundr server listening on http://localhost:${port}`);
  console.log(`Pi cwd: ${cwd}`);
});

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
  await entry.runtime.session.bindExtensions({});
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

process.on("SIGINT", async () => {
  for (const entry of runtimes.values()) {
    entry.unsubscribe?.();
    entry.disposalTimer && clearTimeout(entry.disposalTimer);
    await entry.runtime.dispose();
  }
  process.exit(0);
});
