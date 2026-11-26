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
  const a = msg as AssistantMessage | undefined;
  return Boolean(a && a.role === "assistant" && a.stopReason !== "error" && a.stopReason !== "aborted");
}

export function isEditableEntry(entry: SessionEntry): boolean {
  if (entry.type === "custom_message") return true;
  if (entry.type !== "message") return false;
  const r = entry.message.role;
  return r === "user" || r === "assistant" || r === "toolResult";
}

export function reconstructState(branchEntries: readonly SessionEntry[]): DcpStateData {
  let start = 0;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]!.type === "compaction") { start = i + 1; break; }
  }
  const active = branchEntries.slice(start);
  const activeIds = new Set(active.map((e) => e.id));
  for (let i = active.length - 1; i >= 0; i--) {
    const entry = active[i]!;
    if (entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
    const raw = entry.data as Partial<DcpStateData> | undefined;
    if (!raw || raw.version !== 1) continue;
    const keep = (ids: unknown): string[] =>
      Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && activeIds.has(id)))] : [];
    const pick = (id: unknown): string | null => (typeof id === "string" && activeIds.has(id) ? id : null);
    return {
      version: 1,
      lastFoldEndEntryId: pick(raw.lastFoldEndEntryId),
      foldTurnEntryIds: keep(raw.foldTurnEntryIds),
      prunedEntryIds: keep(raw.prunedEntryIds),
      foldCount: typeof raw.foldCount === "number" && Number.isInteger(raw.foldCount) && raw.foldCount >= 0 ? raw.foldCount : 0,
      lastNudgeEntryId: pick(raw.lastNudgeEntryId),
    };
  }
  return createEmptyState();
}

export function buildToolCallIndex(contextEntries: readonly ProjectedSessionEntry[]) {
  const byCallId = new Map<string, ToolCallInfo>();
  const resultEntryIdsByCallId = new Map<string, string[]>();
  for (let i = 0; i < contextEntries.length; i++) {
    const pe = contextEntries[i]!;
    for (const msg of pe.messages) {
      if (isVisibleAssistant(msg)) {
        for (const b of msg.content) {
          if (b.type === "toolCall") {
            byCallId.set(b.id, { callId: b.id, name: b.name, arguments: (b.arguments ?? {}) as Record<string, unknown>, assistantEntryId: pe.sourceEntry.id, assistantIndex: i });
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
  const found: AssistantMessage[] = [];
  for (let i = contextEntries.length - 1; i >= 0 && found.length < 2; i--) {
    for (const msg of contextEntries[i]!.messages) {
      if (isVisibleAssistant(msg)) { found.push(msg); if (found.length === 2) break; }
    }
  }
  const latest = found[0];
  if (!latest) return { isCold: false, prevCacheRead: null, gapMs: null };
  const gapMs = found[1] ? latest.timestamp - found[1].timestamp : null;
  const cacheRead = typeof latest.usage?.cacheRead === "number" ? latest.usage.cacheRead : null;
  const cacheWrite = typeof latest.usage?.cacheWrite === "number" ? latest.usage.cacheWrite : 0;
  return { isCold: (cacheRead === 0 && cacheWrite > 0) || (gapMs !== null && gapMs > cacheTtlMs), prevCacheRead: cacheRead, gapMs };
}

export function sanitizeContextEditDrafts(drafts: readonly ContextEditEntryDraft[], contextEntries: readonly ProjectedSessionEntry[]): ContextEditEntryDraft[] {
  const valid = new Set(contextEntries.filter((pe) => pe.messages.length > 0 && isEditableEntry(pe.sourceEntry)).map((pe) => pe.sourceEntry.id));
  const byTarget = new Map<string, ContextEditEntryDraft>();
  for (const d of drafts) {
    if (!valid.has(d.targetId)) continue;
    const r = d.replacement;
    if (r !== null && (typeof r !== "object" || !("content" in r) || (typeof r.content !== "string" && !Array.isArray(r.content)))) continue;
    if (byTarget.get(d.targetId)?.replacement === null) continue;
    byTarget.set(d.targetId, d);
  }
  return [...byTarget.values()];
}

export function countAssistantTurnsSince(contextEntries: readonly ProjectedSessionEntry[], sinceEntryIds: readonly (string | null)[]): number {
  let start = -1;
  for (const id of sinceEntryIds) if (id) start = Math.max(start, contextEntries.findIndex((pe) => pe.sourceEntry.id === id));
  let turns = 0;
  for (let i = start + 1; i < contextEntries.length; i++) if (contextEntries[i]!.messages.some(isVisibleAssistant)) turns++;
  return turns;
}
