import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import { command, events, getFiles, getMessages, getModels, getSessions, getState, getStats } from "./api";

type StreamEvent = { type?: string; [key: string]: any };

type PromptState = {
  id: string;
  runtimeKey: string;
  promptType: "select" | "input" | "confirm";
  title: string;
  options?: string[];
  placeholder?: string;
};

type FileSuggestion = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type MentionState = {
  start: number;
  end: number;
  raw: string;
  query: string;
  suggestions: FileSuggestion[];
  selectedIndex: number;
  loading: boolean;
};

type SessionItem = {
  path?: string;
  file?: string;
  sessionFile?: string;
  id?: string;
  name?: string;
  displayName?: string;
  cwd?: string;
  created?: string;
  modified?: string;
  timestamp?: string;
  updatedAt?: string;
  firstMessage?: string;
  messageCount?: number;
  runtimeKey?: string;
  isStreaming?: boolean;
  hasLiveRuntime?: boolean;
};

type Message = {
  role?: string;
  content?: any;
  customType?: string;
  details?: any;
};

type RenderedMessage = {
  kind: string;
  label: string;
  text: string;
};

type MessagesResponse = {
  messages?: Message[];
  total?: number;
  start?: number;
};

type ToolRun = {
  id: string;
  name: string;
  argsText: string;
  partialText: string;
  resultText: string;
  status: "running" | "done" | "failed";
};

type ModelOption = {
  provider: string;
  modelId: string;
  name?: string;
  supportsThinking?: boolean;
};

type ModelOptionsResponse = {
  current?: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    availableThinkingLevels?: string[];
  };
  models?: ModelOption[];
  thinkingLevels?: string[];
  runtimeKey?: string;
};

type WebStats = {
  runtimeKey?: string;
  session?: {
    messages?: number;
    userMessages?: number;
    assistantMessages?: number;
    toolCalls?: number;
    toolResults?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
    contextTokens?: number;
    contextWindow?: number;
    contextPct?: number | null;
  };
  tincan?: {
    communication?: boolean;
    persona?: boolean;
    piVersion?: string;
    turns?: number;
    promptInjects?: number;
    rtk?: { available?: boolean; rewrites?: number; commands?: number; saved?: number; pct?: number };
    ask?: { calls?: number; answers?: number; cancelled?: number; lastQuestions?: number };
    squad?: { active?: boolean; toolCalls?: number; agentRuns?: number; running?: number; lastMode?: string; lastAgents?: string[]; topAgents?: Array<[string, number]> };
  } | null;
};

type TranscriptItem =
  | { key: string; type: "message"; rendered: RenderedMessage }
  | { key: string; type: "tool"; tool: ToolRun }
  | { key: string; type: "tool-group"; tools: ToolRun[]; status: ToolRun["status"] };

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

export function App() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"prompt" | "steer" | "followUp">("prompt");
  const [runtimeKey, setRuntimeKey] = useState("default");
  const [state, setState] = useState<any>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionFilter, setSessionFilter] = useState("");
  const [sessionMenuPath, setSessionMenuPath] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [toolRuns, setToolRuns] = useState<ToolRun[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelOptionsResponse>({ models: [], thinkingLevels: [] });
  const [stats, setStats] = useState<WebStats>({});
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const runtimeKeyRef = useRef(runtimeKey);
  const streamingBufferRef = useRef("");
  const streamingFrameRef = useRef<number | null>(null);
  const messageCountRef = useRef(0);
  const sessionFileRef = useRef<string | undefined>(undefined);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  const inputHistoryRef = useRef<string[]>([]);
  const inputHistoryIndexRef = useRef(-1);
  const inputDraftRef = useRef("");
  const toolFallbackIdsRef = useRef(new Map<string, string>());
  const toolSequenceRef = useRef(0);
  const mentionFetchRef = useRef(0);

  const historicalToolIds = useMemo(() => collectHistoricalToolIds(messages), [messages]);
  const filteredSessions = useMemo(() => {
    const query = sessionFilter.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session, index) => {
      const haystack = [
        sessionTitle(session, index),
        session.path,
        session.file,
        session.sessionFile,
        session.cwd,
        session.firstMessage,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [sessionFilter, sessions]);

  useEffect(() => {
    runtimeKeyRef.current = runtimeKey;
  }, [runtimeKey]);

  useEffect(() => {
    autoSizeTextarea(textareaRef.current);
  }, [input]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setMentionState(null);
      return;
    }
    void updateMentionState(textarea.value, textarea.selectionStart ?? textarea.value.length);
  }, [input, runtimeKey]);

  useEffect(() => {
    setToolRuns((prev) => {
      const next = prev.filter((tool) => !historicalToolIds.has(tool.id));
      return next.length === prev.length ? prev : next;
    });
  }, [historicalToolIds]);

  useEffect(() => {
    disposedRef.current = false;
    void Promise.all([loadState(), loadMessages(), loadSessions(), loadModelOptions(), loadStats()]);

    function clearReconnectTimer() {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function closeSource() {
      sourceRef.current?.close();
      sourceRef.current = null;
    }

    function scheduleReconnect() {
      if (disposedRef.current || reconnectTimerRef.current != null) return;
      reconnectAttemptRef.current += 1;
      const delay = Math.min(1000 * 2 ** (reconnectAttemptRef.current - 1), 10000);
      setConnection("reconnecting");
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        openStream();
      }, delay);
    }

    function resolveLiveToolId(event: StreamEvent) {
      const explicit = inferToolId(event, "");
      if (explicit) return explicit;
      const name = String(event.toolName ?? "tool");
      const key = `${name}`;
      if (event.type === "tool_execution_start") {
        const nextId = `live-${name}-${++toolSequenceRef.current}`;
        toolFallbackIdsRef.current.set(key, nextId);
        return nextId;
      }
      const existing = toolFallbackIdsRef.current.get(key);
      if (existing) return existing;
      const nextId = `live-${name}-${++toolSequenceRef.current}`;
      toolFallbackIdsRef.current.set(key, nextId);
      return nextId;
    }

    function handleEvent(event: StreamEvent) {
      if (runtimeKeyRef.current !== runtimeKey) return;
      const eventRuntimeKey = event.state?.runtimeKey ?? runtimeKey;
      if (event.type === "volundr_connected" || event.type === "volundr_session_bound") {
        if (eventRuntimeKey !== runtimeKey) return;
      }

      switch (event.type) {
        case "volundr_connected": {
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();
          setConnection("connected");
          setError(null);
          const nextSessionFile = event.state?.sessionFile;
          const sameSession = !!nextSessionFile && nextSessionFile === sessionFileRef.current;
          if (!sameSession) {
            replaceMessages([]);
            setToolRuns([]);
          }
          sessionFileRef.current = nextSessionFile;
          setState(event.state);
          if (event.state?.runtimeKey) setRuntimeKey(event.state.runtimeKey);
          void Promise.all([loadMessages(sameSession ? messageCountRef.current : undefined), loadSessions(), loadModelOptions(), loadStats()]);
          break;
        }
        case "volundr_session_bound":
          setConnection("connected");
          setError(null);
          sessionFileRef.current = event.state?.sessionFile;
          setState(event.state);
          if (event.state?.runtimeKey) setRuntimeKey(event.state.runtimeKey);
          replaceMessages([]);
          resetStreaming();
          setToolRuns([]);
          void Promise.all([loadMessages(), loadSessions(), loadModelOptions(), loadStats()]);
          break;
        case "agent_start":
          setState((prev: any) => ({ ...(prev ?? {}), isStreaming: true }));
          setToolRuns([]);
          toolFallbackIdsRef.current.clear();
          break;
        case "message_start":
          if (event.message?.role === "assistant") resetStreaming();
          break;
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") appendStreaming(event.assistantMessageEvent.delta);
          break;
        case "tool_execution_start":
          updateToolRun({
            id: resolveLiveToolId(event),
            name: String(event.toolName ?? "tool"),
            argsText: stringifyToolField(event.args),
            status: "running",
          });
          break;
        case "tool_execution_update":
          updateToolRun({
            id: resolveLiveToolId(event),
            name: String(event.toolName ?? "tool"),
            partialText: stringifyToolField(event.partialResult),
            status: "running",
          });
          break;
        case "tool_execution_end": {
          const id = resolveLiveToolId(event);
          updateToolRun({
            id,
            name: String(event.toolName ?? "tool"),
            resultText: stringifyToolField(event.result),
            status: event.isError ? "failed" : "done",
          });
          toolFallbackIdsRef.current.delete(String(event.toolName ?? "tool"));
          break;
        }
        case "message_end":
          if (event.message) {
            commitMessage(event.message);
            if (event.message.role === "assistant") resetStreaming();
          } else {
            void loadMessages(messageCountRef.current);
          }
          break;
        case "agent_end":
          setState((prev: any) => ({ ...(prev ?? {}), isStreaming: false }));
          resetStreaming();
          void Promise.all([loadState(), loadStats()]);
          break;
        case "thinking_level_changed":
        case "model_select":
          void Promise.all([loadState(), loadModelOptions(), loadStats()]);
          break;
        case "volundr_sessions_changed":
          void loadSessions();
          break;
        case "queue_update":
          void loadState();
          break;
        case "volundr_error":
          setError(event.message ?? "unknown error");
          break;
        case "volundr_notify":
          setError(event.message ?? null);
          break;
        case "volundr_prompt":
          setPromptState({
            id: String(event.id ?? ""),
            runtimeKey: String(event.runtimeKey ?? runtimeKeyRef.current),
            promptType: event.promptType,
            title: String(event.title ?? ""),
            options: Array.isArray(event.options) ? event.options.map((item: unknown) => String(item)) : undefined,
            placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
          });
          break;
      }
    }

    function openStream() {
      if (disposedRef.current) return;
      clearReconnectTimer();
      closeSource();
      setConnection(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");
      const source = events(runtimeKey);
      sourceRef.current = source;
      source.onmessage = (message) => handleEvent(JSON.parse(message.data) as StreamEvent);
      source.onerror = () => {
        if (disposedRef.current) return;
        setError("event stream disconnected");
        closeSource();
        scheduleReconnect();
      };
    }

    openStream();

    return () => {
      disposedRef.current = true;
      clearReconnectTimer();
      closeSource();
      cancelPendingStreaming();
    };
  }, [runtimeKey]);

  function appendStreaming(delta: string) {
    streamingBufferRef.current += delta;
    if (streamingFrameRef.current != null) return;
    streamingFrameRef.current = requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      const next = streamingBufferRef.current;
      streamingBufferRef.current = "";
      if (!next) return;
      setStreamingText((prev) => prev + next);
    });
  }

  function cancelPendingStreaming() {
    if (streamingFrameRef.current != null) {
      cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
  }

  function resetStreaming() {
    cancelPendingStreaming();
    streamingBufferRef.current = "";
    setStreamingText("");
  }

  function replaceMessages(next: Message[]) {
    messageCountRef.current = next.length;
    setMessages(next);
  }

  function updateToolRun(update: Partial<ToolRun> & Pick<ToolRun, "id" | "name" | "status">) {
    setToolRuns((prev) => {
      const index = prev.findIndex((item) => item.id === update.id);
      const nextItem: ToolRun = {
        id: update.id,
        name: update.name,
        argsText: update.argsText ?? (index >= 0 ? prev[index].argsText : ""),
        partialText: update.partialText ?? (index >= 0 ? prev[index].partialText : ""),
        resultText: update.resultText ?? (index >= 0 ? prev[index].resultText : ""),
        status: update.status,
      };
      if (index < 0) return [...prev, nextItem];
      const next = [...prev];
      next[index] = nextItem;
      return next;
    });
  }

  function commitMessage(message: Message) {
    setMessages((prev) => {
      const last = prev.at(-1);
      if (message.role === "user" && last?.role === "user" && extractText(last.content) === extractText(message.content)) {
        const next = [...prev.slice(0, -1), message];
        messageCountRef.current = next.length;
        return next;
      }
      const next = [...prev, message];
      messageCountRef.current = next.length;
      return next;
    });
  }

  async function loadState() {
    const targetRuntimeKey = runtimeKey;
    try {
      const next = await getState(targetRuntimeKey);
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      sessionFileRef.current = next.sessionFile;
      setState(next);
    } catch (err) {
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setError(errorText(err));
    }
  }

  async function loadSessions() {
    try {
      const data = await getSessions();
      setSessions(data.sessions ?? []);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function loadMessages(since?: number) {
    const targetRuntimeKey = runtimeKey;
    try {
      const data = await getMessages(since, targetRuntimeKey) as MessagesResponse;
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      const incoming = data.messages ?? [];
      setMessages((prev) => {
        const start = typeof data.start === "number" ? Math.max(0, data.start) : 0;
        const next = start > 0 ? dedupeMessages([...prev.slice(0, Math.min(start, prev.length)), ...incoming]) : dedupeMessages(incoming);
        messageCountRef.current = next.length;
        return next;
      });
    } catch (err) {
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setError(errorText(err));
    }
  }

  async function loadModelOptions() {
    const targetRuntimeKey = runtimeKey;
    try {
      const next = await getModels(targetRuntimeKey) as ModelOptionsResponse;
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setModelOptions(next);
    } catch (err) {
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setError(errorText(err));
    }
  }

  async function loadStats() {
    const targetRuntimeKey = runtimeKey;
    try {
      const next = await getStats(targetRuntimeKey) as WebStats;
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setStats(next);
    } catch (err) {
      if (runtimeKeyRef.current !== targetRuntimeKey) return;
      setError(errorText(err));
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    const messageType = mode;
    setInput("");
    setError(null);
    pushInputHistory(text);

    if (messageType === "prompt") {
      setMessages((prev) => {
        const next = [...prev, { role: "user", content: [{ type: "text", text }] }];
        messageCountRef.current = next.length;
        return next;
      });
    }

    try {
      await command({ type: messageType, text, runtimeKey } as any);
      await loadState();
    } catch (err) {
      setError(errorText(err));
      await loadMessages();
    }
  }

  async function sendCompact() {
    const instructions = input.trim() || undefined;
    setError(null);
    try {
      await command({ type: "compact", instructions, runtimeKey });
      if (instructions) {
        pushInputHistory(instructions);
        setInput("");
      }
      await loadState();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await Promise.all([loadState(), loadMessages(), loadSessions(), loadModelOptions(), loadStats()]);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function setModelSelection(value: string) {
    const [provider, modelId] = value.split("/");
    if (!provider || !modelId) return;
    await run(async () => {
      await command({ type: "setModel", provider, modelId, runtimeKey });
    });
  }

  async function setThinkingSelection(level: string) {
    if (!level) return;
    await run(() => command({ type: "setThinkingLevel", level, runtimeKey }));
  }

  function prepareRuntimeSwitch(nextRuntimeKey?: string) {
    replaceMessages([]);
    resetStreaming();
    setToolRuns([]);
    setStats({});
    setModelOptions({ models: [], thinkingLevels: [] });
    setState(null);
    setConnection("connecting");
    if (nextRuntimeKey) setRuntimeKey(nextRuntimeKey);
  }

  async function createNewSession() {
    setError(null);
    try {
      const result = await command({ type: "newSession", runtimeKey });
      prepareRuntimeSwitch((result as any)?.runtimeKey);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function shutdownApp() {
    setError(null);
    try {
      await command({ type: "shutdown" });
      setConnection("reconnecting");
      setError("völundr shutting down");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function answerPrompt(value: string | boolean | null) {
    const active = promptState;
    if (!active) return;
    try {
      await command({ type: "promptResponse", id: active.id, value, runtimeKey: active.runtimeKey });
      setPromptState((current) => current?.id === active.id ? null : current);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function switchToSession(path: string) {
    setError(null);
    try {
      const result = await command({ type: "switchSession", path, runtimeKey });
      prepareRuntimeSwitch((result as any)?.runtimeKey);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function updateMentionState(value: string, selectionStart: number) {
    const mention = findMention(value, selectionStart);
    if (!mention) {
      setMentionState(null);
      return;
    }

    const requestId = ++mentionFetchRef.current;
    setMentionState((current) => ({
      start: mention.start,
      end: mention.end,
      raw: mention.raw,
      query: mention.query,
      suggestions: current?.query === mention.query ? current.suggestions : [],
      selectedIndex: 0,
      loading: true,
    }));

    try {
      const response = await getFiles(mention.query, runtimeKey) as { files?: FileSuggestion[] };
      if (mentionFetchRef.current !== requestId) return;
      const suggestions = Array.isArray(response.files) ? response.files : [];
      setMentionState({
        start: mention.start,
        end: mention.end,
        raw: mention.raw,
        query: mention.query,
        suggestions,
        selectedIndex: suggestions.length ? 0 : -1,
        loading: false,
      });
    } catch {
      if (mentionFetchRef.current !== requestId) return;
      setMentionState({
        start: mention.start,
        end: mention.end,
        raw: mention.raw,
        query: mention.query,
        suggestions: [],
        selectedIndex: -1,
        loading: false,
      });
    }
  }

  function applyMentionSuggestion(suggestion: FileSuggestion) {
    const active = mentionState;
    const textarea = textareaRef.current;
    if (!active || !textarea) return;

    const before = input.slice(0, active.start);
    const after = input.slice(active.end);
    const insertion = formatMentionInsertion(suggestion.path);
    const nextValue = `${before}${insertion}${after}`;
    const nextCursor = before.length + insertion.length;

    setInput(nextValue);
    setMentionState(null);

    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
      autoSizeTextarea(textarea);
    });
  }

  function moveMentionSelection(direction: -1 | 1) {
    setMentionState((current) => {
      if (!current || !current.suggestions.length) return current;
      const size = current.suggestions.length;
      return {
        ...current,
        selectedIndex: (current.selectedIndex + direction + size) % size,
      };
    });
  }

  useEffect(() => {
    const menu = mentionMenuRef.current;
    const active = mentionState;
    if (!menu || !active || active.selectedIndex < 0) return;
    const item = menu.querySelector<HTMLElement>(`[data-mention-index="${active.selectedIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [mentionState?.selectedIndex, mentionState?.suggestions.length]);

  async function renameSession(path: string, currentName?: string) {
    const next = window.prompt("Rename session", currentName ?? "");
    setSessionMenuPath(null);
    if (next == null) return;
    const name = next.trim();
    if (!name) return;
    await run(() => command({ type: "renameSession", path, name, runtimeKey }));
  }

  async function deleteSession(path: string, active?: boolean) {
    const confirmed = window.confirm("Delete this session?");
    setSessionMenuPath(null);
    if (!confirmed) return;
    await run(() => command({ type: "deleteSession", path, runtimeKey }));
    if (active) {
      replaceMessages([]);
      resetStreaming();
      setToolRuns([]);
      setState(null);
    }
  }

  function pushInputHistory(text: string) {
    if (!text) return;
    const history = inputHistoryRef.current;
    if (history.at(-1) !== text) history.push(text);
    if (history.length > 50) history.splice(0, history.length - 50);
    inputHistoryIndexRef.current = -1;
    inputDraftRef.current = "";
  }

  function navigateInputHistory(direction: -1 | 1) {
    const history = inputHistoryRef.current;
    if (!history.length) return;
    if (inputHistoryIndexRef.current === -1) inputDraftRef.current = input;
    const nextIndex = Math.max(-1, Math.min(history.length - 1, inputHistoryIndexRef.current - direction));
    inputHistoryIndexRef.current = nextIndex;
    setInput(nextIndex === -1 ? inputDraftRef.current : history[history.length - 1 - nextIndex]);
  }

  return (
    <main class="shell">
      <header class="topbar">
        <div class="brandBlock">
          <h1>völundr</h1>
          <p>Pi web runtime shell</p>
        </div>
        <div class="state statusGroup">
          <span class={state?.isStreaming ? "runningState" : ""}>{state?.isStreaming ? "running" : "idle"}</span>
          <span>{connection}</span>
        </div>
      </header>

      {error && <section class="error">{error}</section>}

      <section class="grid gridWithStats">
        <aside class="panel sessions">
          <div class="panelTitle">
            <strong>Sessions</strong>
            <button onClick={() => void run(loadSessions)}>refresh</button>
          </div>
          <button class="wide" onClick={() => void createNewSession()}>new session</button>
          <input
            class="sessionSearch"
            value={sessionFilter}
            placeholder="filter sessions"
            onInput={(event) => setSessionFilter((event.currentTarget as HTMLInputElement).value)}
          />
          <div class="sessionList">
            {filteredSessions.map((session, index) => {
              const path = session.path ?? session.file ?? session.sessionFile;
              const active = !!path && path === state?.sessionFile;
              return (
                <div key={path ?? index} class={`sessionShell ${active ? "activeSessionShell" : ""}`}>
                  <button
                    class={`sessionItem ${active ? "activeSession" : ""}`}
                    disabled={!path || active}
                    title={path ?? ""}
                    onClick={() => path && !active && void switchToSession(path)}
                  >
                    <span class="sessionPrimary">
                      <span>{sessionTitle(session, index)}</span>
                      {session.isStreaming && <span class="sessionLiveDot" aria-label="running" />}
                    </span>
                    <small>{sessionMeta(session)}</small>
                  </button>
                  {path && (
                    <div class="sessionMenuWrap">
                      <button class="sessionMenuButton" onClick={() => setSessionMenuPath((prev) => prev === path ? null : path)}>⋯</button>
                      {sessionMenuPath === path && (
                        <div class="sessionMenu">
                          <button onClick={() => void renameSession(path, session.displayName ?? session.name)}>rename</button>
                          <button class="sessionDelete" onClick={() => void deleteSession(path, active)}>delete</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <section class="workspace">
          <TranscriptPanel
            messages={messages}
            streamingText={streamingText}
            toolRuns={toolRuns}
            isStreaming={state?.isStreaming}
          />

          <footer class="composer panel">
            <select value={mode} onChange={(event) => setMode((event.currentTarget as HTMLSelectElement).value as any)}>
              <option value="prompt">prompt</option>
              <option value="steer">steer</option>
              <option value="followUp">follow-up</option>
            </select>
            <div class="composerInputWrap">
              <textarea
                ref={textareaRef}
                rows={2}
                value={input}
                placeholder="Tell Pi what to do..."
                onInput={(event) => {
                  const textarea = event.currentTarget as HTMLTextAreaElement;
                  setInput(textarea.value);
                  void updateMentionState(textarea.value, textarea.selectionStart ?? textarea.value.length);
                }}
                onClick={(event) => {
                  const textarea = event.currentTarget as HTMLTextAreaElement;
                  void updateMentionState(textarea.value, textarea.selectionStart ?? textarea.value.length);
                }}
                onKeyUp={(event) => {
                  if (mentionState && ["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  const textarea = event.currentTarget as HTMLTextAreaElement;
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                    void updateMentionState(textarea.value, textarea.selectionStart ?? textarea.value.length);
                  }
                }}
                onKeyDown={(event) => {
                  if (mentionState?.suggestions.length) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveMentionSelection(1);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveMentionSelection(-1);
                      return;
                    }
                    if (event.key === "Tab" || event.key === "Enter") {
                      const choice = mentionState.suggestions[Math.max(0, mentionState.selectedIndex)];
                      if (choice) {
                        event.preventDefault();
                        applyMentionSuggestion(choice);
                        return;
                      }
                    }
                  }
                  if (event.key === "Escape") {
                    if (mentionState) {
                      event.preventDefault();
                      setMentionState(null);
                      return;
                    }
                    if (state?.isStreaming) {
                      event.preventDefault();
                      void run(() => command({ type: "abort", runtimeKey }));
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "ArrowUp") {
                    event.preventDefault();
                    navigateInputHistory(-1);
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "ArrowDown") {
                    event.preventDefault();
                    navigateInputHistory(1);
                  }
                }}
              />
              {mentionState && (
                <MentionMenu
                  menuRef={mentionMenuRef}
                  mention={mentionState}
                  onSelect={applyMentionSuggestion}
                />
              )}
            </div>
            <div class="composerActions">
              <button onClick={() => void send()}>send</button>
              <button onClick={() => void sendCompact()}>compact</button>
              <button onClick={() => void run(() => command({ type: "abort", runtimeKey }))}>abort</button>
              <button class="dangerButton" onClick={() => void shutdownApp()}>quit</button>
            </div>
          </footer>
        </section>

        <aside class="panel statsRail">
          <ConfigPanel
            state={state}
            modelOptions={modelOptions}
            onSetModel={setModelSelection}
            onSetThinking={setThinkingSelection}
          />
          <div class="statsRailSpacer" />
          <div>
            <div class="panelTitle">
              <strong>Stats</strong>
              <span class="statsBadge">live</span>
            </div>
            <StatsPanel stats={stats} />
          </div>
        </aside>
      </section>

      {promptState && (
        <PromptDialog
          prompt={promptState}
          onSubmit={answerPrompt}
          onCancel={() => void answerPrompt(null)}
        />
      )}
    </main>
  );
}

function MentionMenu({
  mention,
  onSelect,
  menuRef,
}: {
  mention: MentionState;
  onSelect: (suggestion: FileSuggestion) => void;
  menuRef?: { current: HTMLDivElement | null };
}) {
  return (
    <div ref={menuRef} class="mentionMenu" role="listbox" aria-label="Path suggestions">
      {mention.loading && <div class="mentionEmpty">loading…</div>}
      {!mention.loading && !mention.suggestions.length && <div class="mentionEmpty">no matches</div>}
      {mention.suggestions.map((suggestion, index) => (
        <button
          key={suggestion.path}
          data-mention-index={index}
          class={`mentionItem ${index === mention.selectedIndex ? "activeMentionItem" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(suggestion);
          }}
        >
          <span class="mentionPath">@{suggestion.path}</span>
          <span class="mentionMeta">{suggestion.isDirectory ? "dir" : "file"}</span>
        </button>
      ))}
    </div>
  );
}

function PromptDialog({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: PromptState;
  onSubmit: (value: string | boolean | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const titleLines = useMemo(() => prompt.title.split(/\n{2,}|\n/).filter(Boolean), [prompt.title]);

  useEffect(() => {
    setInputValue("");
  }, [prompt.id]);

  return (
    <div class="promptOverlay" role="dialog" aria-modal="true">
      <div class="promptCard panel">
        <div class="panelTitle">
          <strong>{prompt.promptType === "input" ? "Input required" : prompt.promptType === "confirm" ? "Confirm action" : "Choose option"}</strong>
          <span class="statsBadge">extension ui</span>
        </div>
        <div class="promptBody">
          {titleLines.map((line, index) => <p key={`${prompt.id}-${index}`}>{line}</p>)}
          {prompt.promptType === "select" && (
            <div class="promptOptions">
              {(prompt.options ?? []).map((option) => (
                <button key={option} class="promptOption" onClick={() => void onSubmit(option)}>{option}</button>
              ))}
            </div>
          )}
          {prompt.promptType === "confirm" && (
            <div class="promptActionsInline">
              <button onClick={() => void onSubmit(true)}>confirm</button>
              <button class="ghostButton" onClick={() => void onSubmit(false)}>cancel</button>
            </div>
          )}
          {prompt.promptType === "input" && (
            <form class="promptInputForm" onSubmit={(event) => {
              event.preventDefault();
              void onSubmit(inputValue);
            }}>
              <input
                autoFocus
                value={inputValue}
                placeholder={prompt.placeholder ?? "Type answer..."}
                onInput={(event) => setInputValue((event.currentTarget as HTMLInputElement).value)}
              />
              <div class="promptActionsInline">
                <button type="submit">submit</button>
                <button type="button" class="ghostButton" onClick={onCancel}>cancel</button>
              </div>
            </form>
          )}
        </div>
        {prompt.promptType === "select" && (
          <div class="promptFooterActions">
            <button class="ghostButton" onClick={onCancel}>cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

function TranscriptPanel({
  messages,
  streamingText,
  toolRuns,
  isStreaming,
}: {
  messages: Message[];
  streamingText: string;
  toolRuns: ToolRun[];
  isStreaming?: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const history = useMemo(() => normalizeTranscript(messages), [messages]);
  const liveToolRuns = useMemo(() => toolRuns.filter((tool) => !history.toolIds.has(tool.id)), [toolRuns, history.toolIds]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [history.items.length, liveToolRuns.length]);

  useEffect(() => {
    if (!streamingText) return;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [streamingText]);

  return (
    <section class="panel transcript">
      <div class="panelTitle">
        <strong>Transcript</strong>
        <span class={`statsBadge ${isStreaming ? "runningState" : ""}`}>{history.items.filter((item) => item.type === "message").length} messages</span>
      </div>
      <div ref={logRef} class="log">
        {history.items.map((item) => {
          if (item.type === "message") return <MessageBlock key={item.key} {...item.rendered} />;
          if (item.type === "tool") return <ToolRunBlock key={item.key} tool={item.tool} />;
          return <ToolRunGroup key={item.key} tools={item.tools} status={item.status} />;
        })}
        {groupSequentialTools(liveToolRuns).map((item) => {
          if (item.type === "tool") return <ToolRunBlock key={item.key} tool={item.tool} />;
          if (item.type === "tool-group") return <ToolRunGroup key={item.key} tools={item.tools} status={item.status} />;
          return null;
        })}
        {streamingText && <MessageBlock kind="assistant" label="völundr" text={streamingText} />}
      </div>
    </section>
  );
}

function ConfigPanel({
  state,
  modelOptions,
  onSetModel,
  onSetThinking,
}: {
  state: any;
  modelOptions: ModelOptionsResponse;
  onSetModel: (value: string) => Promise<void>;
  onSetThinking: (value: string) => Promise<void>;
}) {
  return (
    <section class="statCard configCard">
      <div class="statTitle">Config</div>
      <div class="statBody">
        <StatRow label="cwd" value={shortenPath(state?.cwd ?? "unknown")} />
        <label class="configField">
          <span>model</span>
          <select
            class="topSelect configSelect"
            value={`${state?.model?.provider ?? modelOptions.current?.provider ?? ""}/${state?.model?.id ?? state?.model?.modelId ?? modelOptions.current?.modelId ?? ""}`}
            onChange={(event) => void onSetModel((event.currentTarget as HTMLSelectElement).value)}
          >
            {(modelOptions.models ?? []).map((model) => (
              <option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`}>
                {friendlyModelLabel(model)}
              </option>
            ))}
          </select>
        </label>
        <label class="configField">
          <span>thinking</span>
          <select
            class="topSelect configSelect"
            value={state?.thinkingLevel ?? modelOptions.current?.thinkingLevel ?? "medium"}
            onChange={(event) => void onSetThinking((event.currentTarget as HTMLSelectElement).value)}
          >
            {(state?.availableThinkingLevels ?? modelOptions.current?.availableThinkingLevels ?? modelOptions.thinkingLevels ?? []).map((level: string) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function StatsPanel({ stats }: { stats: WebStats }) {
  const session = stats.session ?? {};
  const tincan = stats.tincan;
  const topAgents = tincan?.squad?.topAgents ?? [];
  const contextPct = typeof session.contextPct === "number" ? Math.max(0, Math.min(100, session.contextPct)) : null;

  return (
    <div class="statsGrid">
      <StatCard title="Session">
        <StatRow label="messages" value={fmtNum(session.messages)} />
        <StatRow label="user" value={fmtNum(session.userMessages)} />
        <StatRow label="assistant" value={fmtNum(session.assistantMessages)} />
        <StatRow label="tool calls" value={fmtNum(session.toolCalls)} />
        <StatRow label="tool results" value={fmtNum(session.toolResults)} />
      </StatCard>

      <StatCard title="Context Window">
        <StatDetail
          label="usage"
          value={session.contextWindow ? `${fmtNum(session.contextTokens)} / ${fmtNum(session.contextWindow)} (${contextPct != null ? `${fmtPct(contextPct)}%` : "n/a"})` : "n/a"}
          extra={contextPct != null ? <ProgressBar value={contextPct} /> : undefined}
        />
        <StatDetail
          label="tokens"
          value={joinStatParts([
            `in: ${fmtNum(session.inputTokens)}`,
            `out: ${fmtNum(session.outputTokens)}`,
            `total: ${fmtNum(session.totalTokens)}`,
            `cost: ${typeof session.cost === "number" ? `$${session.cost.toFixed(4)}` : "$0.0000"}`,
          ])}
        />
      </StatCard>

      <StatCard title="Tincan">
        <StatRow label="communication" value={tincan?.communication ? "on" : "off"} />
        <StatRow label="persona" value={tincan?.persona ? "on" : "off"} />
        <StatRow label="turns" value={fmtNum(tincan?.turns)} />
        <StatRow label="prompt injects" value={fmtNum(tincan?.promptInjects)} />
      </StatCard>

      <StatCard title="Squad">
        <StatRow label="fires" value={fmtNum(tincan?.squad?.toolCalls)} />
        <StatRow label="runs" value={fmtNum(tincan?.squad?.agentRuns)} />
        <StatRow label="live" value={fmtNum(tincan?.squad?.running)} />
        <StatRow label="mode" value={tincan?.squad?.lastMode ?? "idle"} />
      </StatCard>

      <StatCard title="RTK">
        <StatRow label="available" value={tincan?.rtk?.available ? "yes" : "no"} />
        <StatRow label="session cmds" value={fmtNum(tincan?.rtk?.commands)} />
        <StatRow label="rewrites" value={fmtNum(tincan?.rtk?.rewrites)} />
        <StatRow label="session saved" value={fmtNum(tincan?.rtk?.saved)} />
        <StatRow label="rate" value={tincan?.rtk?.pct != null ? `${Math.round(tincan.rtk.pct)}%` : "0%"} />
      </StatCard>

      <StatCard title="Top agents">
        {topAgents.length ? topAgents.map(([name, count]) => <StatRow key={name} label={name} value={fmtNum(count)} />) : <div class="statsEmpty">no runs yet</div>}
      </StatCard>
    </div>
  );
}

function StatCard({ title, children }: { title: string; children: any }) {
  return (
    <section class="statCard">
      <div class="statTitle">{title}</div>
      <div class="statBody">{children}</div>
    </section>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="statRow">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatDetail({ label, value, extra }: { label: string; value: string; extra?: any }) {
  return (
    <div class="statDetail">
      <div class="statRow statRowTop">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      {extra}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div class="progressBar" aria-label={`Context usage ${clamped.toFixed(2)}%`}>
      <div class="progressBarFill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function normalizeTranscript(messages: Message[]) {
  const items: TranscriptItem[] = [];
  const toolIds = new Set<string>();
  const pendingToolIndexes = new Map<string, number>();
  const pendingOrder: string[] = [];

  for (const [index, message] of messages.entries()) {
    const tools = extractHistoricalToolRuns(message, index);

    if (message.role === "toolResult" && tools.length === 1) {
      const resultTool = tools[0];
      const targetId = pendingToolIndexes.has(resultTool.id)
        ? resultTool.id
        : pendingOrder.at(-1);
      if (targetId) {
        const targetIndex = pendingToolIndexes.get(targetId);
        if (targetIndex != null) {
          const item = items[targetIndex];
          if (item?.type === "tool") {
            item.tool = {
              ...item.tool,
              resultText: resultTool.resultText || item.tool.resultText,
              status: resultTool.status,
            };
            pendingToolIndexes.delete(targetId);
            const orderIndex = pendingOrder.lastIndexOf(targetId);
            if (orderIndex >= 0) pendingOrder.splice(orderIndex, 1);
            continue;
          }
        }
      }
    }

    const rendered = renderMessage(message);
    if (rendered) {
      items.push({
        key: `message-${message.role ?? message.customType ?? "message"}-${index}`,
        type: "message",
        rendered,
      });
    }

    for (const tool of tools) {
      items.push({ key: tool.id, type: "tool", tool });
      toolIds.add(tool.id);
      if (!tool.resultText) {
        pendingToolIndexes.set(tool.id, items.length - 1);
        pendingOrder.push(tool.id);
      }
    }
  }

  return { items: groupSequentialTools(items), toolIds };
}

function groupSequentialTools(items: Array<TranscriptItem | ToolRun>) {
  const grouped: TranscriptItem[] = [];
  let toolBuffer: ToolRun[] = [];

  function flush() {
    if (!toolBuffer.length) return;
    if (toolBuffer.length === 1) {
      grouped.push({ key: toolBuffer[0].id, type: "tool", tool: toolBuffer[0] });
    } else {
      grouped.push({
        key: `tool-group-${toolBuffer.map((tool) => tool.id).join("-")}`,
        type: "tool-group",
        tools: [...toolBuffer],
        status: toolBuffer.some((tool) => tool.status === "failed") ? "failed" : toolBuffer.some((tool) => tool.status === "running") ? "running" : "done",
      });
    }
    toolBuffer = [];
  }

  for (const item of items as any[]) {
    if (item.type === "tool") {
      toolBuffer.push(item.tool);
      continue;
    }
    if (item.id && item.name) {
      toolBuffer.push(item as ToolRun);
      continue;
    }
    flush();
    grouped.push(item);
  }

  flush();
  return grouped;
}

function MessageBlock({ kind, label, text }: RenderedMessage) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongText(text);
  const shown = long && !expanded ? truncateText(text, 1600, 20) : text;

  return (
    <div class={`messageRow ${kind}`}>
      <div class={`messageBlock ${kind}`}>
        <div class="blockHeader">
          <div class="messageRole">{label}</div>
          <div class="blockActions">
            <CopyButton text={text} />
            {long && <button class="ghostButton" onClick={() => setExpanded((prev) => !prev)}>{expanded ? "less" : "more"}</button>}
          </div>
        </div>
        <div class="messageText"><RichText text={shown} /></div>
      </div>
    </div>
  );
}

function ToolRunGroup({ tools, status }: { tools: ToolRun[]; status: ToolRun["status"] }) {
  const names = Array.from(new Set(tools.map((tool) => tool.name))).join(", ");
  return (
    <details class={`messageBlock tool toolBlock toolGroup ${status}`}>
      <summary class="toolSummary">
        <span class="toolChevron" aria-hidden="true">▸</span>
        <span class="toolHeadline">{tools.length} tools · {names}</span>
        <span class="toolHint">expand</span>
      </summary>
      <div class="toolGroupItems">
        {tools.map((tool) => <ToolRunBlock key={tool.id} tool={tool} nested />)}
      </div>
    </details>
  );
}

function ToolRunBlock({ tool, nested = false }: { tool: ToolRun; nested?: boolean }) {
  const summary = toolSummary(tool);
  const detailsText = [
    tool.argsText ? `args\n${tool.argsText}` : "",
    tool.partialText ? `progress\n${tool.partialText}` : "",
    tool.resultText ? `${tool.status === "failed" ? "error" : "result"}\n${tool.resultText}` : "",
  ].filter(Boolean).join("\n\n");

  return (
    <details class={`messageBlock tool toolBlock ${nested ? "toolNested" : ""} ${tool.status}`}>
      <summary class="toolSummary">
        <span class="toolChevron" aria-hidden="true">▸</span>
        <span class="toolHeadline">{summary}</span>
        <span class="toolHint">details</span>
      </summary>
      <div class="toolMeta">
        <CopyButton text={detailsText || summary} />
      </div>
      {tool.argsText && <ToolSection label="args" text={tool.argsText} />}
      {tool.partialText && <ToolSection label="progress" text={tool.partialText} />}
      {tool.resultText && <ToolSection label={tool.status === "failed" ? "error" : "result"} text={tool.resultText} />}
    </details>
  );
}

function ToolSection({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongText(text);
  const shown = long && !expanded ? truncateText(text, 1400, 18) : text;

  return (
    <div class="toolDetails">
      <div class="toolSectionHeader">
        <span>{label}</span>
        {long && <button class="ghostButton" onClick={() => setExpanded((prev) => !prev)}>{expanded ? "less" : "more"}</button>}
      </div>
      <RichText text={shown} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return <button class="ghostButton" onClick={onCopy}>{copied ? "copied" : "copy"}</button>;
}

function RichText({ text }: { text: string }) {
  const html = useMemo(() => markdown.render(text), [text]);
  return <div class="markdownRoot" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderMessage(message: Message): RenderedMessage | null {
  const role = message.role;
  if (role === "user") return { kind: "user", label: "you", text: extractText(message.content) };
  if (role === "assistant") {
    if (isPureToolCallMessage(message)) return null;
    const text = extractText(message.content);
    return text ? { kind: "assistant", label: "völundr", text } : null;
  }
  if (role === "tool" || role === "toolResult") return null;
  if (message.customType) {
    const text = extractText(message.content ?? message.details);
    return text ? { kind: "meta", label: message.customType, text } : null;
  }
  return null;
}

function extractHistoricalToolRuns(message: Message, index: number): ToolRun[] {
  const tools = new Map<string, ToolRun>();

  function upsertTool(source: any, itemIndex: number, mode: "call" | "result") {
    const id = inferToolId(source, `history-tool-${index}-${itemIndex}`);
    const existing = tools.get(id);
    const argsText = mode === "call" ? extractToolArgs(source) || existing?.argsText || "" : existing?.argsText || extractToolArgs(source);
    const resultText = mode === "result" ? extractToolResult(source) || existing?.resultText || "" : existing?.resultText || "";
    tools.set(id, {
      id,
      name: inferToolName(source) || existing?.name || "tool",
      argsText,
      partialText: existing?.partialText || "",
      resultText,
      status: mode === "result" ? inferToolStatus(source) : existing?.status ?? (resultText ? "done" : "running"),
    });
  }

  if (message.role === "tool") upsertTool(message.content ?? message.details ?? message, 0, "call");
  if (message.role === "toolResult") upsertTool(message.content ?? message.details ?? message, 0, "result");

  if (Array.isArray(message.content)) {
    message.content.forEach((item, itemIndex) => {
      if (!item || typeof item !== "object") return;
      if (item.type === "toolCall") upsertTool(item, itemIndex, "call");
      if (item.type === "tool_result" || item.type === "toolResult") upsertTool(item, itemIndex, "result");
    });
  }

  return [...tools.values()];
}

function collectHistoricalToolIds(messages: Message[]) {
  const ids = new Set<string>();
  messages.forEach((message, index) => {
    extractHistoricalToolRuns(message, index).forEach((tool) => ids.add(tool.id));
  });
  return ids;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return shortJson(content);

  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") return shortJson(item);
      if (item.type === "text") return item.text ?? "";
      if (item.type === "thinking") return "";
      if (item.type === "image") return "[image]";
      if (item.type === "tool_result" || item.type === "toolResult" || item.type === "toolCall") return "";
      return item.text ?? item.content ?? shortJson(item);
    })
    .filter(Boolean);

  return parts.join("\n\n");
}

function isPureToolCallMessage(message: Message) {
  if (!Array.isArray(message.content) || message.content.length !== 1) return false;
  const item = message.content[0];
  return !!item && typeof item === "object" && item.type === "toolCall";
}

function dedupeMessages(messages: Message[]) {
  const next: Message[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const key = `${message.role ?? "unknown"}:${message.customType ?? ""}:${extractText(message.content ?? message.details)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(message);
  }
  return next;
}

function isLongText(text: string) {
  return text.length > 1600 || text.split("\n").length > 20;
}

function truncateText(text: string, maxChars: number, maxLines: number) {
  const lines = text.split("\n");
  const clippedLines = lines.slice(0, maxLines).join("\n");
  const clipped = clippedLines.length > maxChars ? clippedLines.slice(0, maxChars) : clippedLines;
  return clipped === text ? text : `${clipped}\n…`;
}

function autoSizeTextarea(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = "0px";
  node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
}

function findMention(value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const raw = match[2] ?? "";
  const start = cursor - raw.length - 1;
  return {
    start,
    end: cursor,
    raw: `@${raw}`,
    query: raw,
  };
}

function formatMentionInsertion(path: string) {
  return path.includes(" ") ? `"${path}" ` : `${path} `;
}

function joinStatParts(parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(" · ");
}

function fmtNum(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "0";
}

function fmtPct(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function shortJson(value: unknown) {
  if (value == null) return "";
  const text = JSON.stringify(value);
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

function stringifyToolField(value: unknown) {
  if (typeof value === "string") return value;
  return shortJson(value);
}

function inferToolId(value: any, fallback: string) {
  return value?.toolCallId
    ?? value?.tool_call_id
    ?? value?.toolUseId
    ?? value?.tool_use_id
    ?? value?.id
    ?? value?.call?.id
    ?? fallback;
}

function inferToolName(value: any) {
  return value?.toolName
    ?? value?.tool_name
    ?? value?.name
    ?? value?.tool?.name
    ?? value?.call?.name
    ?? "tool";
}

function inferToolStatus(value: any): ToolRun["status"] {
  return value?.isError || value?.error ? "failed" : "done";
}

function extractToolArgs(value: any) {
  return stringifyToolField(
    value?.args
      ?? value?.arguments
      ?? value?.input
      ?? value?.toolInput
      ?? value?.toolArguments
      ?? value?.call?.arguments,
  );
}

function extractToolResult(value: any) {
  return stringifyToolField(
    value?.result
      ?? value?.text
      ?? value?.content
      ?? value?.output
      ?? value?.details
      ?? value,
  );
}

function toolSummary(tool: ToolRun) {
  const base = `${tool.status === "running" ? "running" : tool.status === "failed" ? "failed" : "done"} ${tool.name}`;
  const detail = oneLine(tool.partialText || tool.resultText || tool.argsText);
  return detail ? `${base} · ${detail}` : base;
}

function friendlyModelLabel(model: ModelOption) {
  const primary = model.name?.trim() || model.modelId;
  const provider = model.provider.replace(/[-_]+/g, " ");
  return `${primary} · ${provider}`;
}

function sessionTitle(session: SessionItem, index: number) {
  return session.displayName
    ?? session.name
    ?? oneLine(session.firstMessage)
    ?? `session ${index + 1}`;
}

function sessionMeta(session: SessionItem) {
  const cwd = session.cwd ? shortenPath(session.cwd) : "unknown cwd";
  const when = formatTimestamp(session.modified ?? session.updatedAt ?? session.created ?? session.timestamp);
  const count = typeof session.messageCount === "number" ? `${session.messageCount} msgs` : undefined;
  return [cwd, when, count].filter(Boolean).join(" · ");
}

function shortenPath(path: string) {
  return path.replace(/^\/home\/[^/]+/, "~");
}

function oneLine(text?: string) {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > 96 ? `${collapsed.slice(0, 96)}…` : collapsed;
}

function formatTimestamp(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
