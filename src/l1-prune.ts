import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ContextEditEntryDraft, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { formatBashPlaceholder, formatStaleReadPlaceholder, formatToolPlaceholder } from "./prompts.ts";
import { buildToolCallIndex, detectCacheStatus, isVisibleAssistant, type ToolCallInfo } from "./state.ts";
import type { DcpConfig, DcpStateData } from "./types.ts";

export interface L1PruneInput {
  contextEntries: readonly ProjectedSessionEntry[];
  state: DcpStateData;
  config: DcpConfig;
  cwd: string;
  sessionId: string;
  excludeEntryIds?: ReadonlySet<string>;
  piggybackAfterIndex?: number;
}

export interface L1PruneOutput {
  edits: ContextEditEntryDraft[];
  newlyPrunedIds: string[];
  netSavedTokens: number;
  reason: "none" | "cold-cache" | "min-batch" | "piggyback";
}

interface Candidate {
  index: number;
  entryId: string;
  msg: ToolResultMessage;
  text: string;
  lines: number;
  tokens: number;
  call?: ToolCallInfo;
  staleBy?: string;
}

const DEFAULT_READ_CAP = 2000;

function readRange(args?: Record<string, unknown>): { rawPath: string; start: number; end: number; label: string } | null {
  if (!args || typeof args.path !== "string" || !args.path.trim()) return null;
  const start = typeof args.offset === "number" && args.offset >= 1 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.min(Math.floor(args.limit), DEFAULT_READ_CAP) : DEFAULT_READ_CAP;
  const label = args.offset !== undefined || args.limit !== undefined ? `:${start}-${start + limit - 1}` : "";
  return { rawPath: args.path, start, end: start + limit - 1, label };
}

function computeTailCutIndex(entries: readonly ProjectedSessionEntry[], protectTurns: number, protectTokens: number): number {
  let turnCut = entries.length;
  let seenTurns = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.messages.some((m) => isVisibleAssistant(m))) {
      seenTurns++;
      if (seenTurns >= protectTurns) {
        turnCut = i;
        break;
      }
    }
  }
  if (protectTurns === 0) turnCut = entries.length;
  let tokCut = entries.length;
  let seenTok = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const m of entries[i]!.messages) seenTok += estimateTokens(m);
    if (seenTok >= protectTokens) {
      tokCut = i;
      break;
    }
  }
  if (protectTokens === 0) tokCut = entries.length;
  return Math.min(turnCut, tokCut);
}

function findSupersedingTool(
  entryIdx: number,
  normPath: string,
  start: number,
  end: number,
  entries: readonly ProjectedSessionEntry[],
  byCallId: Map<string, ToolCallInfo>,
  cwd: string,
): string | undefined {
  for (let j = entryIdx + 1; j < entries.length; j++) {
    for (const msg of entries[j]!.messages) {
      if (msg.role !== "toolResult" || msg.isError) continue;
      const call = byCallId.get(msg.toolCallId);
      if (!call) continue;
      if ((call.name === "edit" || call.name === "write") && typeof call.arguments.path === "string") {
        if (path.resolve(cwd, call.arguments.path) === normPath) return call.name;
      } else if (call.name === "read") {
        const later = readRange(call.arguments);
        if (!later || path.resolve(cwd, later.rawPath) !== normPath) continue;
        const details = msg.details as { truncation?: { truncated?: boolean; outputLines?: number } } | undefined;
        const effectiveEnd = details?.truncation?.truncated && typeof details.truncation.outputLines === "number"
          ? later.start + details.truncation.outputLines - 1
          : later.end;
        if (later.start <= start && effectiveEnd >= end) return "read";
      }
    }
  }
  return undefined;
}

function spillBash(text: string, config: DcpConfig, sessionId: string, entryId: string): string | undefined {
  if (!config.spillBashOutput) return undefined;
  const base = config.spillDir ?? path.join(os.tmpdir(), "pi-dcp-spill");
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "session";
  const dir = path.join(base, safeSession);
  const filePath = path.join(dir, `${entryId}.log`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
    return filePath;
  } catch {
    return undefined;
  }
}

function buildPlaceholder(c: Candidate, config: DcpConfig, sessionId: string, doSpill: boolean): string {
  if (c.staleBy && c.call?.name === "read") {
    const r = readRange(c.call.arguments);
    return formatStaleReadPlaceholder(r?.rawPath ?? "file", r?.label ?? "", c.lines, c.tokens, c.staleBy);
  }
  if (c.msg.toolName === "bash") {
    const nativePath = (c.msg.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
    const resolved = typeof nativePath === "string" && nativePath.trim()
      ? nativePath
      : doSpill ? spillBash(c.text, config, sessionId, c.entryId) : undefined;
    const cmd = typeof c.call?.arguments.command === "string" ? c.call.arguments.command : "bash";
    return formatBashPlaceholder(cmd, c.lines, c.tokens, resolved);
  }
  if (c.msg.toolName === "read") {
    const r = readRange(c.call?.arguments);
    return formatToolPlaceholder("read", `${r?.rawPath ?? "file"}${r?.label ?? ""}`, c.lines, c.tokens);
  }
  const argPreview = c.call ? JSON.stringify(c.call.arguments).slice(0, 60) : "";
  return formatToolPlaceholder(c.msg.toolName, argPreview || "output", c.lines, c.tokens);
}

export function planL1Prune(input: L1PruneInput): L1PruneOutput {
  const { contextEntries, state, config, cwd, sessionId, excludeEntryIds, piggybackAfterIndex } = input;
  const empty: L1PruneOutput = { edits: [], newlyPrunedIds: [], netSavedTokens: 0, reason: "none" };
  const cutIndex = computeTailCutIndex(contextEntries, config.tailProtectTurns, config.tailProtectTokens);
  if (cutIndex <= 0) return empty;
  const { byCallId } = buildToolCallIndex(contextEntries);
  const protectedSet = new Set(config.protectedTools);
  const prunedSet = new Set(state.prunedEntryIds);
  const candidates: Candidate[] = [];

  for (let i = 0; i < cutIndex; i++) {
    const pe = contextEntries[i]!;
    const entryId = pe.sourceEntry.id;
    if (pe.messages.length !== 1 || prunedSet.has(entryId) || excludeEntryIds?.has(entryId)) continue;
    const msg = pe.messages[0]!;
    if (msg.role !== "toolResult" || msg.isError || protectedSet.has(msg.toolName)) continue;
    if (msg.content.some((b) => b.type === "image")) continue;
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const tokens = estimateTokens(msg);
    const call = byCallId.get(msg.toolCallId);
    let staleBy: string | undefined;
    if (msg.toolName === "read" && tokens >= config.minStaleReadTokens && call) {
      const r = readRange(call.arguments);
      if (r) staleBy = findSupersedingTool(i, path.resolve(cwd, r.rawPath), r.start, r.end, contextEntries, byCallId, cwd);
    }
    if (!staleBy && tokens < config.oversizedToolTokens) continue;
    candidates.push({ index: i, entryId, msg, text, lines: text ? text.split("\n").length : 0, tokens, call, staleBy });
  }
  if (!candidates.length) return empty;

  const { isCold } = detectCacheStatus(contextEntries, config.cacheTtlMs);
  const calcSavings = (list: Candidate[]): number =>
    list.reduce((sum, c) => sum + Math.max(0, c.tokens - Math.ceil(buildPlaceholder(c, config, sessionId, false).length / 4)), 0);

  let selected: Candidate[] = [];
  let reason: L1PruneOutput["reason"] = "none";
  const allSavings = calcSavings(candidates);
  if (isCold && allSavings >= config.coldCacheMinSaveTokens) {
    selected = candidates;
    reason = "cold-cache";
  } else if (allSavings >= config.minBatchSaveTokens) {
    selected = candidates;
    reason = "min-batch";
  } else if (piggybackAfterIndex !== undefined) {
    const piggyList = isCold ? candidates : candidates.filter((c) => c.index > piggybackAfterIndex);
    if (piggyList.length && calcSavings(piggyList) > 0) {
      selected = piggyList;
      reason = "piggyback";
    }
  }
  if (!selected.length) return empty;

  const edits: ContextEditEntryDraft[] = [];
  const newlyPrunedIds: string[] = [];
  let netSavedTokens = 0;
  for (const c of selected) {
    const placeholder = buildPlaceholder(c, config, sessionId, true);
    const saved = Math.max(0, c.tokens - Math.ceil(placeholder.length / 4));
    if (saved <= 0) continue;
    edits.push({ type: "context_edit", targetId: c.entryId, replacement: { content: placeholder } });
    newlyPrunedIds.push(c.entryId);
    netSavedTokens += saved;
  }
  return edits.length ? { edits, newlyPrunedIds, netSavedTokens, reason } : empty;
}
