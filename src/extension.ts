import type { ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { planL1Prune } from "./l1-prune.ts";
import { buildFoldEdits, planMonotoneFold } from "./l2-compress.ts";
import { COMPRESS_SYSTEM_SECTION, formatFoldResult, formatNudgeMessage } from "./prompts.ts";
import { countAssistantTurnsSince, reconstructState, sanitizeContextEditDrafts } from "./state.ts";
import { loadConfig, NUDGE_CUSTOM_TYPE, STATE_CUSTOM_TYPE, type DcpStateData, type PendingCompressPlan } from "./types.ts";

const CompressParams = Type.Object({
  topic: Type.String({ description: "Short 3-6 word label for the completed phase." }),
  summary: Type.String({ description: "Structured technical summary: Goal/Intent, Key Findings & Decisions, Exact File Paths & Symbols, Open Items/Constraints." }),
  keepRecentTurns: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Number of recent completed assistant turns before this call to keep verbatim (default 0)." })),
});

export function registerPiDcp(pi: ExtensionAPI, options?: { cwd?: string; agentDir?: string; warn?: (msg: string) => void }): void {
  const config = loadConfig(options?.cwd ?? process.cwd(), { agentDir: options?.agentDir, warn: options?.warn });
  if (!config.enabled) return;

  let pendingCompress: PendingCompressPlan | null = null;
  const resetTransient = () => { pendingCompress = null; };

  if (config.compress.enabled) {
    pi.registerTool({
      name: "compress",
      label: "Compress",
      description: "Monotonically fold completed earlier conversation messages into this tool call's structured summary.",
      exposure: "model-only",
      parameters: CompressParams,
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        if (pendingCompress) return { isError: true, content: [{ type: "text", text: "A compress fold is already queued for this turn." }], details: { ok: false } };
        const state = reconstructState(ctx.sessionManager.getBranch());
        const res = planMonotoneFold({ args: params, currentToolCallId: toolCallId, contextEntries: ctx.sessionManager.buildSessionProjection().entries, state, config });
        if (!res.ok) return { isError: true, content: [{ type: "text", text: res.error }], details: { ok: false } };
        pendingCompress = res.plan;
        return {
          content: [{ type: "text", text: formatFoldResult(res.plan) }],
          details: { ok: true, topic: res.plan.topic, foldedCount: res.plan.foldedEntryIds.length, compressedTokens: res.plan.compressedTokens, summaryTokens: res.plan.summaryTokens, foldNumber: res.plan.foldNumber },
        };
      },
    });
    pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections["dcp"] = COMPRESS_SYSTEM_SECTION; });
  }

  pi.on("turn_end", (event, ctx) => {
    const rawPlan = pendingCompress;
    pendingCompress = null;
    if (event.outcome !== "completed") return undefined;
    const plan = rawPlan && event.message.role === "assistant" && event.message.content.some((b) => b.type === "toolCall" && b.id === rawPlan.toolCallId)
      ? rawPlan
      : null;

    const contextEntries = event.context.contextEntries;
    const state = reconstructState(ctx.sessionManager.getBranch());
    const foldEdits = plan ? buildFoldEdits(plan) : [];
    const foldEndIdx = plan ? contextEntries.findIndex((pe) => pe.sourceEntry.id === plan.endEntryId) : -1;
    const l1 = planL1Prune({
      contextEntries, state, config,
      cwd: ctx.cwd || ctx.sessionManager.getCwd(),
      sessionId: ctx.sessionManager.getSessionId(),
      excludeEntryIds: new Set(plan?.foldedEntryIds ?? []),
      piggybackAfterIndex: foldEndIdx >= 0 ? foldEndIdx : undefined,
    });

    const sanitized = sanitizeContextEditDrafts([...foldEdits, ...l1.edits], contextEntries);
    const appliedIds = new Set(sanitized.map((e) => e.targetId));
    const appliedFold = plan !== null && plan.foldedEntryIds.some((id) => appliedIds.has(id));
    const appliedL1Ids = l1.newlyPrunedIds.filter((id) => appliedIds.has(id));
    const newDrafts: SessionBoundaryDraft[] = [...sanitized];
    let nextState: DcpStateData | null = null;
    const ensureState = (): DcpStateData => (nextState ??= { ...state, foldTurnEntryIds: [...state.foldTurnEntryIds], prunedEntryIds: [...state.prunedEntryIds] });

    if (appliedFold && plan) {
      const s = ensureState();
      const lastTurnResultId = event.toolResultEntryIds[event.toolResultEntryIds.length - 1] ?? event.messageEntryId;
      s.lastFoldEndEntryId = plan.foldedAfterLastUser && plan.keepRecentTurns === 0 ? lastTurnResultId : plan.endEntryId;
      s.foldCount = plan.foldNumber;
      for (const id of [event.messageEntryId, ...event.toolResultEntryIds]) if (!s.foldTurnEntryIds.includes(id)) s.foldTurnEntryIds.push(id);
    }
    if (appliedL1Ids.length) {
      const s = ensureState();
      for (const id of appliedL1Ids) if (!s.prunedEntryIds.includes(id)) s.prunedEntryIds.push(id);
    }

    const usage = ctx.getContextUsage();
    const shouldNudge = config.compress.enabled && !appliedFold && event.toolResults.length > 0 &&
      typeof usage?.percent === "number" && usage.percent >= config.compress.nudgePercent &&
      countAssistantTurnsSince(contextEntries, [state.lastFoldEndEntryId, state.lastNudgeEntryId]) >= config.compress.nudgeMinTurns;
    if (shouldNudge && typeof usage?.percent === "number") {
      ensureState().lastNudgeEntryId = event.messageEntryId;
      newDrafts.push({ type: "custom_message", customType: NUDGE_CUSTOM_TYPE, content: formatNudgeMessage(usage.percent), display: false });
    }
    if (nextState) newDrafts.push({ type: "custom", customType: STATE_CUSTOM_TYPE, data: nextState });
    return newDrafts.length ? { entries: [...event.entries, ...newDrafts] } : undefined;
  });

  pi.on("session_start", resetTransient);
  pi.on("session_tree", resetTransient);
  pi.on("session_compact", resetTransient);
  pi.on("session_before_switch", resetTransient);
  pi.on("session_before_fork", resetTransient);
}
