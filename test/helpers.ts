import type { AssistantMessage, JsonObject, JsonValue, ToolCall, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let seq = 1;
const BASE_TS = 1_760_000_000_000;

export function makeUsage(partial?: Partial<Usage>): Usage {
  return {
    input: 1000,
    output: 100,
    cacheRead: 500,
    cacheWrite: 0,
    totalTokens: 1600,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...partial,
  };
}

export function makeUser(text: string, timestamp = BASE_TS + seq++ * 1000): UserMessage {
  return { role: "user", content: text, timestamp };
}

export function makeAssistant(opts?: {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: AssistantMessage["stopReason"];
  usage?: Partial<Usage>;
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
}): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (opts?.text) content.push({ type: "text", text: opts.text });
  for (const tc of opts?.toolCalls ?? []) content.push(tc);
  if (!content.length) content.push({ type: "text", text: "ok" });
  return {
    role: "assistant",
    content,
    api: opts?.api ?? "anthropic-messages",
    provider: opts?.provider ?? "anthropic",
    model: opts?.model ?? "claude-sonnet-4-5",
    usage: makeUsage(opts?.usage),
    stopReason: opts?.stopReason ?? (opts?.toolCalls?.length ? "toolUse" : "stop"),
    timestamp: opts?.timestamp ?? BASE_TS + seq++ * 1000,
  };
}

export function makeToolCall(id: string, name: string, args: JsonObject): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function makeToolResult(opts: {
  toolCallId: string;
  toolName: string;
  text?: string;
  isError?: boolean;
  details?: JsonValue;
  includeImage?: boolean;
  timestamp?: number;
}): ToolResultMessage {
  const content: ToolResultMessage["content"] = [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  if (opts.includeImage) content.push({ type: "image", data: "AA==", mimeType: "image/png" });
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    content,
    details: opts.details,
    isError: opts.isError ?? false,
    timestamp: opts.timestamp ?? BASE_TS + seq++ * 1000,
  };
}

export function repeatTokens(approxTokens: number, prefix = "line"): string {
  const lines = Math.max(1, Math.ceil((approxTokens * 4) / 48));
  return Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1}: 0123456789abcdefghijklmnopqrstuvwxyz`).join("\n");
}

export function createSession(cwd = "/tmp/pi-dcp-test"): SessionManager {
  return SessionManager.inMemory(cwd);
}
