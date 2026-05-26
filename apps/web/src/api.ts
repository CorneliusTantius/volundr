const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

const inflight = new Map<string, Promise<unknown>>();

async function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const request = fn().finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export type Command =
  | { type: "prompt"; text: string; options?: Record<string, unknown>; runtimeKey?: string }
  | { type: "steer"; text: string; runtimeKey?: string }
  | { type: "followUp"; text: string; runtimeKey?: string }
  | { type: "abort"; runtimeKey?: string }
  | { type: "newSession"; runtimeKey?: string }
  | { type: "switchSession"; path: string; runtimeKey?: string }
  | { type: "compact"; instructions?: string; runtimeKey?: string }
  | { type: "setModel"; provider: string; modelId: string; runtimeKey?: string }
  | { type: "setThinkingLevel"; level: string; runtimeKey?: string }
  | { type: "shutdown" };

function withRuntime(path: string, runtimeKey?: string) {
  if (!runtimeKey) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}runtimeKey=${encodeURIComponent(runtimeKey)}`;
}

export function events(runtimeKey?: string) {
  return new EventSource(withRuntime(`${apiUrl}/api/events`, runtimeKey));
}

export async function command(payload: Command) {
  const response = await fetch(`${apiUrl}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function getState(runtimeKey?: string) {
  return dedup(`state:${runtimeKey || "default"}`, async () => {
    const response = await fetch(withRuntime(`${apiUrl}/api/state`, runtimeKey));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

export async function getSessions() {
  return dedup("sessions", async () => {
    const response = await fetch(`${apiUrl}/api/sessions`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

export async function getMessages(since?: number, runtimeKey?: string) {
  const search = typeof since === "number" ? `?since=${encodeURIComponent(String(since))}` : "";
  return dedup(`messages:${runtimeKey || "default"}:${search || "full"}`, async () => {
    const response = await fetch(withRuntime(`${apiUrl}/api/messages${search}`, runtimeKey));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

export async function getModels(runtimeKey?: string) {
  return dedup(`models:${runtimeKey || "default"}`, async () => {
    const response = await fetch(withRuntime(`${apiUrl}/api/models`, runtimeKey));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

export async function getStats(runtimeKey?: string) {
  return dedup(`stats:${runtimeKey || "default"}`, async () => {
    const response = await fetch(withRuntime(`${apiUrl}/api/stats`, runtimeKey));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}
