import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContextEditEntryDraft, ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createEmptyState, STATE_CUSTOM_TYPE, type DcpStateData } from "./types.ts";

export interface ToolCallInfo {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  assistantEntryId: string;
  assistantIndex: number;
}

export interface CacheStatus {
  isCold: boolean;
  prevCacheRead: number | null;
  gapMs: number | null;
}

export function isVisibleAssistant(msg: unknown): msg is AssistantMessage {
  if (!msg || typeof msg !== "object") return false;
  const a = msg as AssistantMessage;
  return a.role === "assistant" && a.stopReason !== "error" && a.stopReason !== "aborted";
}

export function isEditableEntry(entry: SessionEntry): boolean {
  if (entry.type === "custom_message") return true;
  if (entry.type !== "message") return false;
  const role = entry.message.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

export function reconstructState(branchEntries: readonly SessionEntry[]): DcpStateData {
  let start = 0;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]!.type === "compaction") {
      start = i + 1;
      break;
    }
  }
  const activeSlice = branchEntries.slice(start);
  const activeIds = new Set(activeSlice.map((e) => e.id));
  for (let i = activeSlice.length - 1; i >= 0; i--) {
    const entry = activeSlice[i]!;
    if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
    const raw = entry.data as Partial<DcpStateData> | undefined;
    if (!raw || raw.version !== 1) continue;
    const filterIds = (ids: unknown): string[] =>
      Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && activeIds.has(id)))] : [];
    return {
      version: 1,
      lastFoldEndEntryId: typeof raw.lastFoldEndEntryId === "string" && activeIds.has(raw.lastFoldEndEntryId) ? raw.lastFoldEndEntryId : null,
      foldTurnEntryIds: filterIds(raw.foldTurnEntryIds),
      prunedEntryIds: filterIds(raw.prunedEntryIds),
      foldCount: typeof raw.foldCount === "number" && Number.isInteger(raw.foldCount) && raw.foldCount >= 0 ? raw.foldCount : 0,
      lastNudgeEntryId: typeof raw.lastNudgeEntryId === "string" && activeIds.has(raw.lastNudgeEntryId) ? raw.lastNudgeEntryId : null,
    };
  }
  return createEmptyState();
}

export function buildToolCallIndex(contextEntries: readonly ProjectedSessionEntry[]): {
  byCallId: Map<string, ToolCallInfo>;
  resultEntryIdsByCallId: Map<string, string[]>;
} {
  const byCallId = new Map<string, ToolCallInfo>();
  const resultEntryIdsByCallId = new Map<string, string[]>();
  for (let i = 0; i < contextEntries.length; i++) {
    const pe = contextEntries[i]!;
    for (const msg of pe.messages) {
      if (isVisibleAssistant(msg)) {
        for (const block of msg.content) {
          if (block.type === "toolCall") {
            byCallId.set(block.id, {
              callId: block.id,
              name: block.name,
              arguments: (block.arguments ?? {}) as Record<string, unknown>,
              assistantEntryId: pe.sourceEntry.id,
              assistantIndex: i,
            });
          }
        }
      } else if (msg.role === "toolResult") {
        const list = resultEntryIdsByCallId.get(msg.toolCallId) ?? [];
        list.push(pe.sourceEntry.id);
        resultEntryIdsByCallId.set(msg.toolCallId, list);
      }
    }
  }
  return { byCallId, resultEntryIdsByCallId };
}

export function detectCacheStatus(contextEntries: readonly ProjectedSessionEntry[], cacheTtlMs: number): CacheStatus {
  const assistants: AssistantMessage[] = [];
  for (let i = contextEntries.length - 1; i >= 0 && assistants.length < 2; i--) {
    for (const msg of contextEntries[i]!.messages) {
      if (isVisibleAssistant(msg)) {
        assistants.push(msg);
        if (assistants.length === 2) break;
      }
    }
  }
  const latest = assistants[0];
  if (!latest) return { isCold: false, prevCacheRead: null, gapMs: null };
  const prev = assistants[1];
  const gapMs = prev ? latest.timestamp - prev.timestamp : null;
  const cacheRead = typeof latest.usage?.cacheRead === "number" ? latest.usage.cacheRead : null;
  const cacheWrite = typeof latest.usage?.cacheWrite === "number" ? latest.usage.cacheWrite : 0;
  const explicitCold = cacheRead === 0 && cacheWrite > 0;
  const ttlCold = gapMs !== null && gapMs > cacheTtlMs;
  return { isCold: explicitCold || ttlCold, prevCacheRead: cacheRead, gapMs };
}

export function sanitizeContextEditDrafts(
  drafts: readonly ContextEditEntryDraft[],
  contextEntries: readonly ProjectedSessionEntry[],
): ContextEditEntryDraft[] {
  const validTargets = new Set<string>();
  for (const pe of contextEntries) {
    if (pe.messages.length > 0 && isEditableEntry(pe.sourceEntry)) validTargets.add(pe.sourceEntry.id);
  }
  const byTarget = new Map<string, ContextEditEntryDraft>();
  for (const draft of drafts) {
    if (!validTargets.has(draft.targetId)) continue;
    const r = draft.replacement;
    const validReplacement = r === null || (typeof r === "object" && "content" in r && (typeof r.content === "string" || Array.isArray(r.content)));
    if (!validReplacement) continue;
    const prev = byTarget.get(draft.targetId);
    if (prev && prev.replacement === null) continue;
    byTarget.set(draft.targetId, draft);
  }
  return [...byTarget.values()];
}

export function countAssistantTurnsSince(
  contextEntries: readonly ProjectedSessionEntry[],
  sinceEntryIds: readonly (string | null)[],
): number {
  let startIdx = -1;
  for (const id of sinceEntryIds) {
    if (!id) continue;
    const idx = contextEntries.findIndex((pe) => pe.sourceEntry.id === id);
    if (idx > startIdx) startIdx = idx;
  }
  let turns = 0;
  for (let i = startIdx + 1; i < contextEntries.length; i++) {
    if (contextEntries[i]!.messages.some((m) => isVisibleAssistant(m))) turns++;
  }
  return turns;
}
