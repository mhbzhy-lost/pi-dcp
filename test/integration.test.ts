import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { convertMessages as convertGoogleMessages } from "@earendil-works/pi-ai/api/google-shared";
import { convertMessages as convertOpenAIMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  convertToLlm,
  type ContextUsage,
  type ExtensionAPI,
  type SessionBoundaryDraft,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerPiDcp } from "../src/extension.ts";
import { NUDGE_CUSTOM_TYPE, STATE_CUSTOM_TYPE } from "../src/types.ts";
import { createSession, makeAssistant, makeToolCall, makeToolResult, makeUser, repeatTokens } from "./helpers.ts";

interface Harness {
  tools: Map<string, ToolDefinition>;
  emit: (event: string, payload: any, ctx: any) => Promise<any>;
}

function createHarness(cwd: string, options?: { agentDir?: string; warn?: (m: string) => void }): Harness {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  registerPiDcp(pi, { cwd, agentDir: options?.agentDir, warn: options?.warn });
  return {
    tools,
    async emit(event, payload, ctx) {
      let last: any;
      for (const h of handlers.get(event) ?? []) {
        const r = await h(payload, ctx);
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

function applyDrafts(sm: SessionManager, drafts: readonly SessionBoundaryDraft[]): void {
  for (const d of drafts) {
    if (d.type === "context_edit") sm.appendContextEdit(d.targetId, d.replacement);
    else if (d.type === "custom") sm.appendCustomEntry(d.customType, d.data);
    else if (d.type === "custom_message") sm.appendCustomMessageEntry(d.customType, d.content, d.display, d.details);
    else if (d.type === "compaction") sm.appendCompaction(d.summary, d.firstKeptEntryId ?? sm.getLeafId()!, 0);
  }
}

function makeCtx(sm: SessionManager, usage?: ContextUsage) {
  return {
    cwd: sm.getCwd(),
    sessionManager: sm,
    getContextUsage: () => usage,
  };
}

function makeTurnEnd(sm: SessionManager, msgEntryId: string, toolResultEntryIds: string[], outcome: "completed" | "aborted" | "error" = "completed") {
  const proj = sm.buildSessionProjection();
  const assistant = sm.getEntry(msgEntryId);
  const toolResults = toolResultEntryIds.map((id) => (sm.getEntry(id) as any).message);
  return {
    type: "turn_end",
    turnIndex: 1,
    message: (assistant as any).message,
    toolResults,
    messageEntryId: msgEntryId,
    toolResultEntryIds,
    outcome,
    entries: [] as SessionBoundaryDraft[],
    continue: false,
    context: {
      contextEntries: proj.entries,
      contextMessages: proj.messages,
      llmMessages: convertToLlm(proj.messages),
      pendingMessages: [],
      canContinue: true,
    },
  };
}

const ANTHROPIC_MODEL = { id: "claude-sonnet-4-5", name: "claude", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192 } as Model<"anthropic-messages">;
const GOOGLE_MODEL = { id: "gemini-2.5-pro", name: "gemini", api: "google-generative-ai", provider: "google", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192 } as Model<"google-generative-ai">;
const OPENAI_MODEL = { id: "gpt-4.1", name: "gpt", api: "openai-completions", provider: "openai", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192 } as Model<"openai-completions">;

test("before_agent_start sets systemPromptOptions.sections['dcp'] without returning systemPrompt, and bad config degrades gracefully", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-cfg-"));
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "dcp.json"), "{ bad json");
  const warnings: string[] = [];
  const h = createHarness(dir, { agentDir: path.join(dir, "agent"), warn: (m) => warnings.push(m) });

  assert.ok(warnings.length >= 1);
  const compressTool = h.tools.get("compress");
  assert.ok(compressTool);
  assert.equal(compressTool.exposure, "model-only");

  const sections: Record<string, string> = {};
  const res = await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } }, {});
  assert.equal(res, undefined);
  assert.match(sections.dcp ?? "", /compress/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("end-to-end cold-cache L1 + compress overlap produces zero orphan toolResults and passes Anthropic, Gemini, and OpenAI serializers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-e2e-"));
  const sm = createSession(dir);
  const h = createHarness(dir, { agentDir: path.join(dir, "agent") });
  const ctx = makeCtx(sm, { tokens: 50_000, contextWindow: 200_000, percent: 25 });

  sm.appendMessage(makeUser("Investigate auth and fix login bug"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "bash", { command: "cat big.log" })], usage: { cacheRead: 0, cacheWrite: 5000 } }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "bash", text: repeatTokens(2500) }));
  const a2 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "auth.ts" })], usage: { cacheRead: 0, cacheWrite: 8000 } }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(2500) }));
  // Current turn invokes compress
  const cmpA = sm.appendMessage(makeAssistant({
    toolCalls: [makeToolCall("cmp1", "compress", { topic: "Auth log investigation", summary: "Found token expiry bug in auth.ts:42" })],
    usage: { cacheRead: 0, cacheWrite: 11000 },
  }));

  const compressTool = h.tools.get("compress")!;
  const execRes = await compressTool.execute("cmp1", { topic: "Auth log investigation", summary: "Found token expiry bug in auth.ts:42" }, undefined, undefined, ctx as any);
  assert.notEqual(execRes.isError, true);
  const cmpText = execRes.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const cmpTr = sm.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: cmpText }));

  const turnRes = await h.emit("turn_end", makeTurnEnd(sm, cmpA, [cmpTr]), ctx);
  assert.ok(turnRes?.entries?.length > 0);
  // Every folded entry (a1, tr1, a2, tr2) must be omitted with null, NOT overwritten by L1 placeholder
  const tr1Drafts = turnRes.entries.filter((d: SessionBoundaryDraft) => d.type === "context_edit" && d.targetId === tr1);
  assert.equal(tr1Drafts.length, 1);
  assert.equal(tr1Drafts[0].replacement, null);
  assert.ok(turnRes.entries.some((d: SessionBoundaryDraft) => d.type === "custom" && d.customType === STATE_CUSTOM_TYPE));

  applyDrafts(sm, turnRes.entries);
  const llm = convertToLlm(sm.buildSessionProjection().messages);
  const transformed = transformMessages(llm, ANTHROPIC_MODEL);

  // Zero synthetic "No result provided" results, zero consecutive assistants, strict pairing
  assert.equal(transformed.some((m) => m.role === "toolResult" && m.isError && m.content.some((b) => b.type === "text" && b.text === "No result provided")), false);
  for (let i = 1; i < transformed.length; i++) {
    assert.ok(!(transformed[i - 1]!.role === "assistant" && transformed[i]!.role === "assistant"), "consecutive assistant messages found");
  }
  assert.deepEqual(transformed.map((m) => m.role), ["user", "assistant", "toolResult"]);

  // Verify Google and OpenAI real serializers accept the folded transcript cleanly
  const transcript = normalizeContext({ systemPrompt: "sys", messages: llm });
  const googleContents = convertGoogleMessages(GOOGLE_MODEL, transcript);
  assert.ok(googleContents.length >= 3);
  for (let i = 1; i < googleContents.length; i++) {
    assert.ok(!(googleContents[i - 1]!.role === "model" && googleContents[i]!.role === "model"), "consecutive Gemini model turns");
  }
  const openaiMsgs = convertOpenAIMessages(OPENAI_MODEL, transcript, {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    supportsUsageInStreaming: false, maxTokensField: "max_tokens", requiresToolResultName: false,
    requiresAssistantAfterToolResult: false, requiresThinkingAsText: false, thinkingFormat: "openai",
  } as Parameters<typeof convertOpenAIMessages>[2]);
  assert.ok(openaiMsgs.length >= 4);
  void a1; void a2; void tr2;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compress immediately after U2 preserves U2 verbatim; aborted turn discards pendingCompress; /tree rollback restores state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-u2-"));
  const sm = createSession(dir);
  const h = createHarness(dir, { agentDir: path.join(dir, "agent") });
  const ctx = makeCtx(sm);

  sm.appendMessage(makeUser("Initial task"));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(4000) }));
  const u2Text = "CRITICAL LATEST USER INSTRUCTION " + "Z".repeat(2500);
  sm.appendMessage(makeUser(u2Text));
  const cmpA = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Old work", summary: "Summary" })] }));

  const compressTool = h.tools.get("compress")!;
  const execRes = await compressTool.execute("cmp1", { topic: "Old work", summary: "Summary" }, undefined, undefined, ctx as any);
  assert.notEqual(execRes.isError, true);

  // Aborted turn must commit zero drafts
  const aborted = await h.emit("turn_end", makeTurnEnd(sm, cmpA, [], "aborted"), ctx);
  assert.equal(aborted, undefined);

  // Re-run and commit normally
  const execRes2 = await compressTool.execute("cmp1", { topic: "Old work", summary: "Summary" }, undefined, undefined, ctx as any);
  const cmpTr = sm.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: (execRes2.content[0] as any).text }));
  const preFoldLeaf = sm.getLeafId()!;
  const turnRes = await h.emit("turn_end", makeTurnEnd(sm, cmpA, [cmpTr]), ctx);
  applyDrafts(sm, turnRes.entries);

  const texts = convertToLlm(sm.buildSessionProjection().messages)
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
  assert.ok(texts.includes(u2Text), "U2 must survive verbatim and untruncated");

  // Branch back before fold -> original read output is visible again
  sm.branch(preFoldLeaf);
  await h.emit("session_tree", { type: "session_tree", newLeafId: preFoldLeaf, oldLeafId: sm.getLeafId() }, ctx);
  assert.equal(sm.buildSessionProjection().messages.length, 6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tail nudge fires only during tool loop when percent >= nudgePercent and >= nudgeMinTurns elapsed, never when percent is null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-nudge-"));
  const sm = createSession(dir);
  const h = createHarness(dir, { agentDir: path.join(dir, "agent") });

  sm.appendMessage(makeUser("work"));
  let lastA = "";
  let lastTr = "";
  for (let i = 1; i <= 7; i++) {
    lastA = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall(`c${i}`, "grep", { pattern: `p${i}` })] }));
    lastTr = sm.appendMessage(makeToolResult({ toolCallId: `c${i}`, toolName: "grep", text: "short" }));
  }

  // percent === null -> no nudge
  const nullRes = await h.emit("turn_end", makeTurnEnd(sm, lastA, [lastTr]), makeCtx(sm, { tokens: null, contextWindow: 200_000, percent: null }));
  assert.equal(nullRes, undefined);

  // final assistant text turn (toolResults empty) -> no nudge
  const textA = sm.appendMessage(makeAssistant({ text: "done answering" }));
  const textRes = await h.emit("turn_end", makeTurnEnd(sm, textA, []), makeCtx(sm, { tokens: 150_000, contextWindow: 200_000, percent: 75 }));
  assert.equal(textRes, undefined);

  // tool loop + percent 75% + >= 6 turns -> emits display:false custom_message nudge after toolResult
  const loopA = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c8", "grep", { pattern: "p8" })] }));
  const loopTr = sm.appendMessage(makeToolResult({ toolCallId: "c8", toolName: "grep", text: "ok" }));
  const nudgeRes = await h.emit("turn_end", makeTurnEnd(sm, loopA, [loopTr]), makeCtx(sm, { tokens: 150_000, contextWindow: 200_000, percent: 75 }));
  assert.ok(nudgeRes?.entries?.length > 0);
  const nudgeDraft = nudgeRes.entries.find((d: SessionBoundaryDraft) => d.type === "custom_message" && d.customType === NUDGE_CUSTOM_TYPE);
  assert.ok(nudgeDraft);
  assert.equal(nudgeDraft.display, false);
  applyDrafts(sm, nudgeRes.entries);
  const llm = convertToLlm(sm.buildSessionProjection().messages);
  assert.equal(llm[llm.length - 2]!.role, "toolResult");
  assert.equal(llm[llm.length - 1]!.role, "user");
  void (null as unknown as AssistantMessage);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("turn_end ignores leaked pendingCompress if event.message does not contain the matching compress toolCallId", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-leak-"));
  const sm = createSession(dir);
  const h = createHarness(dir, { agentDir: path.join(dir, "agent") });
  const ctx = makeCtx(sm);

  sm.appendMessage(makeUser("Initial"));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(4000) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Phase", summary: "Summary" })] }));
  const execRes = await h.tools.get("compress")!.execute("cmp1", { topic: "Phase", summary: "Summary" }, undefined, undefined, ctx as any);
  assert.notEqual(execRes.isError, true);

  // Simulate host missing turn_end for cmp1 and firing turn_end on a different subsequent assistant turn
  const otherA = sm.appendMessage(makeAssistant({ text: "unrelated later turn" }));
  const leakedRes = await h.emit("turn_end", makeTurnEnd(sm, otherA, []), ctx);
  assert.equal(leakedRes, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed compress co-issued with sibling bash does not block later compress and keeps all provider serializers valid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-int-sibling-"));
  const sm = createSession(dir);
  const h = createHarness(dir, { agentDir: path.join(dir, "agent") });
  const ctx = makeCtx(sm, { tokens: 60_000, contextWindow: 200_000, percent: 30 });
  const compressTool = h.tools.get("compress")!;

  sm.appendMessage(makeUser("Finish phase 1 and phase 2"));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "p1.ts" })] }));
  sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(4000) }));

  // Fold #1 succeeds
  const cmpA1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Phase 1", summary: "Phase 1 done" })] }));
  const exec1 = await compressTool.execute("cmp1", { topic: "Phase 1", summary: "Phase 1 done" }, undefined, undefined, ctx as any);
  assert.notEqual(exec1.isError, true);
  const cmpTr1 = sm.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: (exec1.content[0] as any).text }));
  const turn1 = await h.emit("turn_end", makeTurnEnd(sm, cmpA1, [cmpTr1]), ctx);
  applyDrafts(sm, turn1.entries);

  // Premature compress co-issued with bash -> compress fails, bash succeeds
  const failA = sm.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("cmpFail", "compress", { topic: "Premature", summary: "Degenerate retry" }),
      makeToolCall("b1", "bash", { command: "git status" }),
    ],
  }));
  const execFail = await compressTool.execute("cmpFail", { topic: "Premature", summary: "Degenerate retry" }, undefined, undefined, ctx as any);
  assert.equal(execFail.isError, true);
  assert.equal((execFail.content[0] as any).text, "No compressible entries available in this phase.");
  const failTr = sm.appendMessage(makeToolResult({ toolCallId: "cmpFail", toolName: "compress", text: (execFail.content[0] as any).text, isError: true }));
  const bashTr = sm.appendMessage(makeToolResult({ toolCallId: "b1", toolName: "bash", text: repeatTokens(2000) }));
  const turnFail = await h.emit("turn_end", makeTurnEnd(sm, failA, [failTr, bashTr]), ctx);
  if (turnFail?.entries?.length) applyDrafts(sm, turnFail.entries);

  // Subsequent real work
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "p2.ts" })] }));
  sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(2500) }));

  // Fold #2 must succeed and fold away failA/failTr/bashTr/c2 cleanly
  const cmpA2 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp2", "compress", { topic: "Phase 2", summary: "Phase 2 done" })] }));
  const exec2 = await compressTool.execute("cmp2", { topic: "Phase 2", summary: "Phase 2 done" }, undefined, undefined, ctx as any);
  assert.notEqual(exec2.isError, true);
  const cmpTr2 = sm.appendMessage(makeToolResult({ toolCallId: "cmp2", toolName: "compress", text: (exec2.content[0] as any).text }));
  const turn2 = await h.emit("turn_end", makeTurnEnd(sm, cmpA2, [cmpTr2]), ctx);
  assert.ok(turn2?.entries?.length > 0);
  applyDrafts(sm, turn2.entries);

  const llm = convertToLlm(sm.buildSessionProjection().messages);
  const transformed = transformMessages(llm, ANTHROPIC_MODEL);
  assert.equal(transformed.some((m) => m.role === "toolResult" && m.isError && m.content.some((b) => b.type === "text" && b.text === "No result provided")), false);
  assert.deepEqual(transformed.map((m) => m.role), ["user", "assistant", "toolResult", "assistant", "toolResult"]);

  const transcript = normalizeContext({ systemPrompt: "sys", messages: llm });
  assert.ok(convertGoogleMessages(GOOGLE_MODEL, transcript).length >= 5);
  assert.ok(convertOpenAIMessages(OPENAI_MODEL, transcript, {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    supportsUsageInStreaming: false, maxTokensField: "max_tokens", requiresToolResultName: false,
    requiresAssistantAfterToolResult: false, requiresThinkingAsText: false, thinkingFormat: "openai",
  } as Parameters<typeof convertOpenAIMessages>[2]).length >= 6);
  fs.rmSync(dir, { recursive: true, force: true });
});
