/**
 * Who called a tool: the MCP client's name, its session id, and stdio or http.
 * A crash in Revit is traced from ai_usage.jsonl back to one bot.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface Caller {
  client: string;
  session: string;
  transport: "stdio" | "http";
}

const store = new AsyncLocalStorage<Caller>();
const known = new Map<string, Caller>();

export function rememberCaller(caller: Caller): void {
  const client = caller.client.trim().slice(0, 120) || "unknown";
  known.set(caller.session, { ...caller, client });
}

export function callerFor(session: string): Caller {
  const hit = known.get(session);
  if (hit) return hit;
  const id = session || "stdio";
  return { client: "unknown", session: id, transport: id === "stdio" ? "stdio" : "http" };
}

export function currentCaller(): Caller {
  return store.getStore() ?? callerFor("stdio");
}

export function runAsCaller<T>(caller: Caller, fn: () => T): T {
  return store.run(caller, fn);
}

/** clientInfo.name from an MCP initialize message, or "" when this message is not initialize. */
export function clientNameFromInitialize(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  if ((message as { method?: unknown }).method !== "initialize") return "";
  const name = (message as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "unknown";
}

/** Remember a stdio client's name. HTTP sessions are stored when the session id exists. */
export function noteMcpMessage(message: unknown, transport: "stdio" | "http", session?: string): void {
  const name = clientNameFromInitialize(message);
  if (!name) return;
  const id = session || (transport === "stdio" ? "stdio" : "");
  if (!id) return;
  rememberCaller({ client: name, session: id, transport });
}

/** Fields stored on every ai_usage.jsonl line, plus the first lines of a send_code script. */
export function usageCallerFields(tool: string, args: { code?: unknown } | undefined): {
  client: string; session: string; transport: "stdio" | "http"; code_head?: string;
} {
  const who = currentCaller();
  const fields: { client: string; session: string; transport: "stdio" | "http"; code_head?: string } = {
    client: who.client, session: who.session, transport: who.transport,
  };
  if (tool === "send_code_to_revit" && typeof args?.code === "string" && args.code.trim()) {
    fields.code_head = args.code.split(/\r?\n/).slice(0, 8).join("\n").slice(0, 500);
  }
  return fields;
}
