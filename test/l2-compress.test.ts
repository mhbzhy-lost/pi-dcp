import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyState, DEFAULT_CONFIG } from "../src/types.ts";
import { buildFoldEdits, planMonotoneFold } from "../src/l2-compress.ts";
import { createSession, makeAssistant, makeToolCall, makeToolResult, makeUser, repeatTokens } from "./helpers.ts";

test("pins first user message (U1) and folds A1..TRn into pure null edits when keepRecentTurns=0", () => {
  const sm = createSession();
  const u1 = sm.appendMessage(makeUser("Initial task specification"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(2200) }));
  const a2 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "b.ts" })] }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(2200) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Read a & b", summary: "Concise summary" })] }));

  const res = planMonotoneFold({
    args: { topic: "Read a & b", summary: "Concise summary of a.ts and b.ts findings" },
    currentToolCallId: "cmp1",
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.plan.foldedEntryIds, [a1, tr1, a2, tr2]);
  assert.ok(!res.plan.foldedEntryIds.includes(u1));
  assert.equal(res.plan.endEntryId, tr2);
  assert.equal(res.plan.foldedAfterLastUser, true);
  const edits = buildFoldEdits(res.plan);
  assert.equal(edits.length, 4);
  assert.ok(edits.every((e) => e.replacement === null));
});

test("pins active latest user message (U2) whether work happens before U2 or after U2", () => {
  // Case A: U2 immediately before compress -> fold strictly before U2, keep U1 and U2
  const smBefore = createSession();
  const u1 = smBefore.appendMessage(makeUser("task 1"));
  const a1 = smBefore.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = smBefore.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(4000) }));
  const u2 = smBefore.appendMessage(makeUser("Brand new long requirement " + "x".repeat(3000)));
  smBefore.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Phase 1", summary: "Done phase 1" })] }));

  const resBefore = planMonotoneFold({
    args: { topic: "Phase 1", summary: "Done phase 1" },
    currentToolCallId: "cmp1",
    contextEntries: smBefore.buildSessionProjection().entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(resBefore.ok, true);
  if (resBefore.ok) {
    assert.deepEqual(resBefore.plan.foldedEntryIds, [a1, tr1]);
    assert.ok(!resBefore.plan.foldedEntryIds.includes(u1));
    assert.ok(!resBefore.plan.foldedEntryIds.includes(u2));
    assert.equal(resBefore.plan.foldedAfterLastUser, false);
  }

  // Case B: substantial work after U2 -> fold only after U2, leaving U1..A1..U2 untouched for cache
  const smAfter = createSession();
  smAfter.appendMessage(makeUser("task 1"));
  smAfter.appendMessage(makeAssistant({ text: "done 1" }));
  const u2b = smAfter.appendMessage(makeUser("task 2"));
  const a2 = smAfter.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "b.ts" })] }));
  const tr2 = smAfter.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(4000) }));
  smAfter.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp2", "compress", { topic: "Phase 2", summary: "Done phase 2" })] }));

  const resAfter = planMonotoneFold({
    args: { topic: "Phase 2", summary: "Done phase 2" },
    currentToolCallId: "cmp2",
    contextEntries: smAfter.buildSessionProjection().entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(resAfter.ok, true);
  if (resAfter.ok) {
    assert.deepEqual(resAfter.plan.foldedEntryIds, [a2, tr2]);
    assert.ok(!resAfter.plan.foldedEntryIds.includes(u2b));
    assert.equal(resAfter.plan.foldedAfterLastUser, true);
  }
});

test("enforces monotone boundary and skips prior foldTurnEntryIds", () => {
  const sm = createSession();
  sm.appendMessage(makeUser("u1"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(3500) }));
  const cmpA1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Fold 1", summary: "Summary 1" })] }));
  const cmpTr1 = sm.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: "[DCP Fold #1]" }));
  sm.appendContextEdit(a1, null);
  sm.appendContextEdit(tr1, null);

  const a2 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "b.ts" })] }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(3500) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp2", "compress", { topic: "Fold 2", summary: "Summary 2" })] }));

  const state = createEmptyState();
  state.lastFoldEndEntryId = cmpTr1;
  state.foldTurnEntryIds = [cmpA1, cmpTr1];
  state.foldCount = 1;

  const res = planMonotoneFold({
    args: { topic: "Fold 2", summary: "Summary 2" },
    currentToolCallId: "cmp2",
    contextEntries: sm.buildSessionProjection().entries,
    state,
    config: DEFAULT_CONFIG,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.plan.foldedEntryIds, [a2, tr2]);
    assert.equal(res.plan.foldNumber, 2);
  }
});

test("respects keepRecentTurns and rejects when keepRecentTurns exceeds available turns", () => {
  const sm = createSession();
  sm.appendMessage(makeUser("u1"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(3500) }));
  const a2 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "b.ts" })] }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(500) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp", "compress", { topic: "T", summary: "S", keepRecentTurns: 1 })] }));

  const okRes = planMonotoneFold({
    args: { topic: "T", summary: "Concise summary", keepRecentTurns: 1 },
    currentToolCallId: "cmp",
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.deepEqual(okRes.plan.foldedEntryIds, [a1, tr1]);
    assert.ok(!okRes.plan.foldedEntryIds.includes(a2));
    assert.ok(!okRes.plan.foldedEntryIds.includes(tr2));
  }

  const tooMany = planMonotoneFold({
    args: { topic: "T", summary: "Concise summary", keepRecentTurns: 5 },
    currentToolCallId: "cmp",
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(tooMany.ok, false);
});

test("rejects unknown toolCallId, micro-fold, bloated summary, and keeps multi-toolCall transactions atomic", () => {
  const sm = createSession();
  sm.appendMessage(makeUser("u1"));
  const a1 = sm.appendMessage(makeAssistant({
    toolCalls: [makeToolCall("c1", "read", { path: "a.ts" }), makeToolCall("c2", "read", { path: "b.ts" })],
  }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(2000) }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(2000) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp", "compress", { topic: "T", summary: "S" })] }));
  const entries = sm.buildSessionProjection().entries;

  const missing = planMonotoneFold({
    args: { topic: "T", summary: "S" },
    currentToolCallId: "not-in-projection",
    contextEntries: entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(missing.ok, false);

  const bloated = planMonotoneFold({
    args: { topic: "T", summary: repeatTokens(3800) },
    currentToolCallId: "cmp",
    contextEntries: entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(bloated.ok, false);

  const valid = planMonotoneFold({
    args: { topic: "Multi", summary: "Short summary" },
    currentToolCallId: "cmp",
    contextEntries: entries,
    state: createEmptyState(),
    config: DEFAULT_CONFIG,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.plan.foldedEntryIds, [a1, tr1, tr2]);

  const micro = planMonotoneFold({
    args: { topic: "Micro", summary: "Tiny" },
    currentToolCallId: "cmp",
    contextEntries: entries,
    state: createEmptyState(),
    config: { ...DEFAULT_CONFIG, compress: { ...DEFAULT_CONFIG.compress, minFoldTokens: 50_000 } },
  });
  assert.equal(micro.ok, false);
});

test("reports no compressible entries when only bookkeeping entries follow lastFoldEndEntryId", () => {
  const sm = createSession();
  sm.appendMessage(makeUser("u1"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(3500) }));
  const cmpA1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Fold 1", summary: "Summary 1" })] }));
  const cmpTr1 = sm.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: "[DCP Fold #1]" }));
  sm.appendContextEdit(a1, null);
  sm.appendContextEdit(tr1, null);
  sm.appendCustomEntry("pi-dcp:state", { version: 1, lastFoldEndEntryId: cmpTr1, foldTurnEntryIds: [cmpA1, cmpTr1], prunedEntryIds: [], foldCount: 1, lastNudgeEntryId: null });
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp2", "compress", { topic: "Immediate retry", summary: "Summary 2" })] }));

  const state = createEmptyState();
  state.lastFoldEndEntryId = cmpTr1;
  state.foldTurnEntryIds = [cmpA1, cmpTr1];
  state.foldCount = 1;

  const res = planMonotoneFold({
    args: { topic: "Immediate retry", summary: "Summary 2" },
    currentToolCallId: "cmp2",
    contextEntries: sm.buildSessionProjection().entries,
    state,
    config: DEFAULT_CONFIG,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "No compressible entries available in this phase.");
});

test("failed compress with sibling toolCall does not poison subsequent folds, while succeeded compress protects sibling toolResults atomically", () => {
  // Case 1: failed compress + sibling bash -> NOT protected, cleanly folded by later compress
  const sm1 = createSession();
  sm1.appendMessage(makeUser("u1"));
  const a1 = sm1.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm1.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: repeatTokens(3500) }));
  const cmpA1 = sm1.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp1", "compress", { topic: "Fold 1", summary: "Summary 1" })] }));
  const cmpTr1 = sm1.appendMessage(makeToolResult({ toolCallId: "cmp1", toolName: "compress", text: "[DCP Fold #1]" }));
  sm1.appendContextEdit(a1, null);
  sm1.appendContextEdit(tr1, null);

  const failA = sm1.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("cmpFail", "compress", { topic: "Premature", summary: "Bloated retry" }),
      makeToolCall("b1", "bash", { command: "git status" }),
    ],
  }));
  const failTr = sm1.appendMessage(makeToolResult({ toolCallId: "cmpFail", toolName: "compress", text: "No compressible entries available in this phase.", isError: true }));
  const bashTr = sm1.appendMessage(makeToolResult({ toolCallId: "b1", toolName: "bash", text: repeatTokens(2000) }));
  const a2 = sm1.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "read", { path: "b.ts" })] }));
  const tr2 = sm1.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "read", text: repeatTokens(2000) }));
  sm1.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmp2", "compress", { topic: "Fold 2", summary: "Summary 2" })] }));

  const state1 = createEmptyState();
  state1.lastFoldEndEntryId = cmpTr1;
  state1.foldTurnEntryIds = [cmpA1, cmpTr1];
  state1.foldCount = 1;

  const res1 = planMonotoneFold({
    args: { topic: "Fold 2", summary: "Summary 2" },
    currentToolCallId: "cmp2",
    contextEntries: sm1.buildSessionProjection().entries,
    state: state1,
    config: DEFAULT_CONFIG,
  });
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.deepEqual(res1.plan.foldedEntryIds, [failA, failTr, bashTr, a2, tr2]);
  }

  // Case 2: succeeded compress + sibling bash with keepRecentTurns > 0 -> entire turn protected atomically even without foldTurnEntryIds
  const sm2 = createSession();
  sm2.appendMessage(makeUser("u1"));
  const p1 = sm2.appendMessage(makeAssistant({ toolCalls: [makeToolCall("p1", "read", { path: "p1.ts" })] }));
  const ptr1 = sm2.appendMessage(makeToolResult({ toolCallId: "p1", toolName: "read", text: repeatTokens(3500) }));
  const p2 = sm2.appendMessage(makeAssistant({ toolCalls: [makeToolCall("p2", "read", { path: "p2.ts" })] }));
  const ptr2 = sm2.appendMessage(makeToolResult({ toolCallId: "p2", toolName: "read", text: repeatTokens(2000) }));
  const okCmpA = sm2.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("cmpOk", "compress", { topic: "Fold 1", summary: "Summary 1", keepRecentTurns: 1 }),
      makeToolCall("b2", "bash", { command: "ls" }),
    ],
  }));
  const okCmpTr = sm2.appendMessage(makeToolResult({ toolCallId: "cmpOk", toolName: "compress", text: "[DCP Fold #1]" }));
  const okBashTr = sm2.appendMessage(makeToolResult({ toolCallId: "b2", toolName: "bash", text: "ok" }));
  sm2.appendContextEdit(p1, null);
  sm2.appendContextEdit(ptr1, null);
  const p3 = sm2.appendMessage(makeAssistant({ toolCalls: [makeToolCall("p3", "read", { path: "p3.ts" })] }));
  const ptr3 = sm2.appendMessage(makeToolResult({ toolCallId: "p3", toolName: "read", text: repeatTokens(2000) }));
  sm2.appendMessage(makeAssistant({ toolCalls: [makeToolCall("cmpNext", "compress", { topic: "Fold 2", summary: "Summary 2" })] }));

  const state2 = createEmptyState();
  state2.lastFoldEndEntryId = ptr1;
  state2.foldCount = 1;

  const res2 = planMonotoneFold({
    args: { topic: "Fold 2", summary: "Summary 2" },
    currentToolCallId: "cmpNext",
    contextEntries: sm2.buildSessionProjection().entries,
    state: state2,
    config: DEFAULT_CONFIG,
  });
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.deepEqual(res2.plan.foldedEntryIds, [p2, ptr2, p3, ptr3]);
    assert.ok(!res2.plan.foldedEntryIds.includes(okCmpA));
    assert.ok(!res2.plan.foldedEntryIds.includes(okCmpTr));
    assert.ok(!res2.plan.foldedEntryIds.includes(okBashTr));
  }
});
