import { estimateTokens, type ContextEditEntryDraft, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { buildToolCallIndex, isEditableEntry, isVisibleAssistant } from "./state.ts";
import type { DcpConfig, DcpStateData, PendingCompressPlan } from "./types.ts";

export interface CompressArgs {
  topic: string;
  summary: string;
  keepRecentTurns?: number;
}

export type FoldPlanResult = { ok: true; plan: PendingCompressPlan } | { ok: false; error: string };

function isVisibleUser(pe: ProjectedSessionEntry): boolean {
  return pe.messages.length > 0 && pe.sourceEntry.type === "message" && pe.sourceEntry.message.role === "user";
}

function extractUserText(pe: ProjectedSessionEntry): string {
  const m = pe.messages[0];
  if (!m || m.role !== "user") return "";
  return (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")).trim();
}

function collectProtectedFoldIds(entries: readonly ProjectedSessionEntry[], state: DcpStateData, resultsByCallId: Map<string, string[]>): Set<string> {
  const ids = new Set(state.foldTurnEntryIds);
  for (const pe of entries) {
    for (const msg of pe.messages) {
      if (!isVisibleAssistant(msg)) continue;
      for (const b of msg.content) {
        if (b.type === "toolCall" && b.name === "compress") {
          ids.add(pe.sourceEntry.id);
          for (const rid of resultsByCallId.get(b.id) ?? []) ids.add(rid);
        }
      }
    }
  }
  return ids;
}

export function planMonotoneFold(params: {
  args: CompressArgs;
  currentToolCallId: string;
  contextEntries: readonly ProjectedSessionEntry[];
  state: DcpStateData;
  config: DcpConfig;
}): FoldPlanResult {
  const { args, currentToolCallId, contextEntries, state, config } = params;
  const topic = args.topic.trim();
  const summary = args.summary.trim();
  if (!topic || !summary) return { ok: false, error: "compress requires non-empty topic and summary." };

  const keepRecentTurns = Math.max(0, Math.min(10, Math.floor(args.keepRecentTurns ?? 0)));
  const { byCallId, resultEntryIdsByCallId } = buildToolCallIndex(contextEntries);
  const currentCall = byCallId.get(currentToolCallId);
  if (!currentCall) return { ok: false, error: `Unable to locate active compress call ${currentToolCallId} in session projection.` };
  const currentAssistantIdx = currentCall.assistantIndex;

  let firstUserIdx = -1, lastUserIdx = -1;
  for (let i = 0; i < currentAssistantIdx; i++) {
    if (isVisibleUser(contextEntries[i]!)) { if (firstUserIdx < 0) firstUserIdx = i; lastUserIdx = i; }
  }
  const prevEndIdx = state.lastFoldEndEntryId ? contextEntries.findIndex((pe) => pe.sourceEntry.id === state.lastFoldEndEntryId) : -1;
  const protectedFoldIds = collectProtectedFoldIds(contextEntries, state, resultEntryIdsByCallId);
  const indexById = new Map(contextEntries.map((pe, i) => [pe.sourceEntry.id, i]));

  const evaluateWindow = (minStart: number, maxEnd: number, foldedAfterLastUser: boolean): FoldPlanResult => {
    if (minStart > maxEnd) return { ok: false, error: "No compressible entries available in this phase." };
    let endIdx = maxEnd;
    if (keepRecentTurns > 0) {
      let skipped = 0, cut = -1;
      for (let i = maxEnd; i >= minStart; i--) {
        if (contextEntries[i]!.messages.some(isVisibleAssistant) && ++skipped === keepRecentTurns) { cut = i - 1; break; }
      }
      if (skipped < keepRecentTurns || cut < minStart) return { ok: false, error: `keepRecentTurns=${keepRecentTurns} leaves no earlier turns to fold.` };
      endIdx = cut;
    }

    const selected = new Set<number>();
    for (let i = minStart; i <= endIdx; i++) {
      const pe = contextEntries[i]!;
      if (pe.messages.length > 0 && isEditableEntry(pe.sourceEntry) && !protectedFoldIds.has(pe.sourceEntry.id)) selected.add(i);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const idx of [...selected]) {
        for (const msg of contextEntries[idx]!.messages) {
          if (isVisibleAssistant(msg)) {
            for (const b of msg.content) {
              if (b.type !== "toolCall") continue;
              for (const rid of resultEntryIdsByCallId.get(b.id) ?? []) {
                const rIdx = indexById.get(rid);
                if (rIdx === undefined || rIdx >= currentAssistantIdx || rIdx > maxEnd || protectedFoldIds.has(rid)) {
                  return { ok: false, error: "Fold boundary would split an active or protected tool transaction." };
                }
                if (!selected.has(rIdx)) { selected.add(rIdx); changed = true; }
              }
            }
          } else if (msg.role === "toolResult") {
            const owner = byCallId.get(msg.toolCallId);
            if (!owner) return { ok: false, error: `Orphan toolResult ${contextEntries[idx]!.sourceEntry.id} cannot be folded safely.` };
            if (owner.assistantIndex < minStart || protectedFoldIds.has(owner.assistantEntryId)) {
              return { ok: false, error: "Fold boundary would cross a frozen prefix or protected fold turn." };
            }
            if (!selected.has(owner.assistantIndex)) { selected.add(owner.assistantIndex); changed = true; }
          }
        }
      }
    }

    const sortedIdx = [...selected].sort((a, b) => a - b);
    if (sortedIdx.length < 2) return { ok: false, error: "Need at least 2 compressible entries to fold." };
    let compressedTokens = 0;
    const preservedUsers: string[] = [];
    for (const i of sortedIdx) {
      const pe = contextEntries[i]!;
      for (const m of pe.messages) compressedTokens += estimateTokens(m);
      if (isVisibleUser(pe)) { const txt = extractUserText(pe); if (txt) preservedUsers.push(`- ${txt}`); }
    }
    if (compressedTokens < config.compress.minFoldTokens) return { ok: false, error: `Span too small to fold (~${compressedTokens} < ${config.compress.minFoldTokens} tokens).` };
    const preservedUsersText = preservedUsers.join("\n");
    const summaryTokens = Math.ceil((topic.length + summary.length + preservedUsersText.length + 120) / 4);
    if (summaryTokens >= compressedTokens * config.compress.maxRetentionRatio) {
      return { ok: false, error: `Summary too large (~${summaryTokens} vs ~${compressedTokens} tokens; ratio >= ${config.compress.maxRetentionRatio}).` };
    }
    const foldedEntryIds = sortedIdx.map((i) => contextEntries[i]!.sourceEntry.id);
    return {
      ok: true,
      plan: { topic, summary, foldedEntryIds, endEntryId: foldedEntryIds[foldedEntryIds.length - 1]!, foldedAfterLastUser, keepRecentTurns, preservedUsersText, compressedTokens, summaryTokens, foldNumber: state.foldCount + 1 },
    };
  };

  const afterStart = Math.max(lastUserIdx + 1, prevEndIdx + 1);
  const afterRes = evaluateWindow(afterStart, currentAssistantIdx - 1, true);
  if (afterRes.ok) return afterRes;
  if (lastUserIdx > firstUserIdx) {
    const beforeStart = Math.max(firstUserIdx + 1, prevEndIdx + 1);
    const beforeEnd = lastUserIdx - 1;
    if (beforeStart <= beforeEnd) {
      const beforeRes = evaluateWindow(beforeStart, beforeEnd, false);
      if (beforeRes.ok) return beforeRes;
      return afterStart > currentAssistantIdx - 1 ? beforeRes : afterRes;
    }
  }
  return afterRes;
}

export function buildFoldEdits(plan: PendingCompressPlan): ContextEditEntryDraft[] {
  return plan.foldedEntryIds.map((targetId) => ({ type: "context_edit", targetId, replacement: null }));
}
