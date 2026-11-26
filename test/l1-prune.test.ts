import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmptyState, DEFAULT_CONFIG, type DcpConfig } from "../src/types.ts";
import { planL1Prune } from "../src/l1-prune.ts";
import { createSession, makeAssistant, makeToolCall, makeToolResult, makeUser, repeatTokens } from "./helpers.ts";

function coldConfig(overrides?: Partial<DcpConfig>): DcpConfig {
  return {
    ...DEFAULT_CONFIG,
    tailProtectTurns: 2,
    tailProtectTokens: 0,
    coldCacheMinSaveTokens: 100,
    minBatchSaveTokens: 20_000,
    ...overrides,
  };
}

test("protects tail window by max of tailProtectTurns and tailProtectTokens", () => {
  const sm = createSession("/repo");
  sm.appendMessage(makeUser("go"));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "bash", { command: "ls" })], usage: { cacheRead: 0, cacheWrite: 1000 } }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "bash", text: repeatTokens(2500) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "bash", { command: "pwd" })], usage: { cacheRead: 0, cacheWrite: 1000 } }));
  const tr2 = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "bash", text: repeatTokens(2500) }));
  sm.appendMessage(makeAssistant({ text: "recent1", usage: { cacheRead: 0, cacheWrite: 1000 } }));
  sm.appendMessage(makeAssistant({ text: "recent2", usage: { cacheRead: 0, cacheWrite: 1000 } }));

  const out = planL1Prune({
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: coldConfig({ tailProtectTurns: 2, tailProtectTokens: 2000, spillBashOutput: false }),
    cwd: "/repo",
    sessionId: "s1",
  });
  // tr2 (~2500 tok) satisfies tailProtectTokens=2000, protecting tr2 while leaving tr1 eligible
  assert.deepEqual(out.newlyPrunedIds, [tr1]);
  assert.ok(!out.newlyPrunedIds.includes(tr2));
});

test("exempts isError toolResults, protectedTools, image-bearing toolResults, already pruned, and excludeEntryIds", () => {
  const sm = createSession("/repo");
  sm.appendMessage(makeUser("go"));
  sm.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("cErr", "bash", { command: "fail" }),
      makeToolCall("cSub", "subagent", { task: "x" }),
      makeToolCall("cImg", "read", { path: "pic.png" }),
      makeToolCall("cPrev", "grep", { pattern: "foo" }),
      makeToolCall("cExcl", "grep", { pattern: "bar" }),
      makeToolCall("cOk", "grep", { pattern: "baz" }),
    ],
    usage: { cacheRead: 0, cacheWrite: 1000 },
  }));
  sm.appendMessage(makeToolResult({ toolCallId: "cErr", toolName: "bash", text: repeatTokens(2500), isError: true }));
  sm.appendMessage(makeToolResult({ toolCallId: "cSub", toolName: "subagent", text: repeatTokens(2500) }));
  sm.appendMessage(makeToolResult({ toolCallId: "cImg", toolName: "read", text: repeatTokens(2500), includeImage: true }));
  const trPrev = sm.appendMessage(makeToolResult({ toolCallId: "cPrev", toolName: "grep", text: repeatTokens(2500) }));
  const trExcl = sm.appendMessage(makeToolResult({ toolCallId: "cExcl", toolName: "grep", text: repeatTokens(2500) }));
  const trOk = sm.appendMessage(makeToolResult({ toolCallId: "cOk", toolName: "grep", text: repeatTokens(2500) }));
  sm.appendMessage(makeAssistant({ text: "t1", usage: { cacheRead: 0, cacheWrite: 1000 } }));
  sm.appendMessage(makeAssistant({ text: "t2", usage: { cacheRead: 0, cacheWrite: 1000 } }));

  const state = createEmptyState();
  state.prunedEntryIds = [trPrev];
  const out = planL1Prune({
    contextEntries: sm.buildSessionProjection().entries,
    state,
    config: coldConfig({ spillBashOutput: false }),
    cwd: "/repo",
    sessionId: "s2",
    excludeEntryIds: new Set([trExcl]),
  });
  assert.deepEqual(out.newlyPrunedIds, [trOk]);
});

test("stale read eviction respects Pi 2000-line unbounded read cap and failed edits", () => {
  const sm = createSession("/repo");
  sm.appendMessage(makeUser("inspect"));
  sm.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("r1", "read", { path: "src/a.ts", offset: 1, limit: 100 }),
      makeToolCall("rFar", "read", { path: "src/big.ts", offset: 5000, limit: 100 }),
      makeToolCall("rFailEdit", "read", { path: "src/c.ts", offset: 1, limit: 50 }),
    ],
    usage: { cacheRead: 0, cacheWrite: 1000 },
  }));
  const trR1 = sm.appendMessage(makeToolResult({ toolCallId: "r1", toolName: "read", text: repeatTokens(400) }));
  const trRFar = sm.appendMessage(makeToolResult({ toolCallId: "rFar", toolName: "read", text: repeatTokens(400) }));
  const trRFail = sm.appendMessage(makeToolResult({ toolCallId: "rFailEdit", toolName: "read", text: repeatTokens(400) }));

  // Later: successful edit on ./src/a.ts, unbounded read on src/big.ts (only covers 1..2000!), FAILED edit on src/c.ts
  sm.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("e1", "edit", { path: "./src/a.ts", edits: [{ oldText: "x", newText: "y" }] }),
      makeToolCall("r2", "read", { path: "src/big.ts" }),
      makeToolCall("eFail", "edit", { path: "src/c.ts", edits: [{ oldText: "x", newText: "y" }] }),
    ],
    usage: { cacheRead: 0, cacheWrite: 1000 },
  }));
  sm.appendMessage(makeToolResult({ toolCallId: "e1", toolName: "edit", text: "ok" }));
  sm.appendMessage(makeToolResult({ toolCallId: "r2", toolName: "read", text: "short head" }));
  sm.appendMessage(makeToolResult({ toolCallId: "eFail", toolName: "edit", text: "not found", isError: true }));
  sm.appendMessage(makeAssistant({ text: "t1", usage: { cacheRead: 0, cacheWrite: 1000 } }));
  sm.appendMessage(makeAssistant({ text: "t2", usage: { cacheRead: 0, cacheWrite: 1000 } }));

  const out = planL1Prune({
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: coldConfig({ minStaleReadTokens: 200 }),
    cwd: "/repo",
    sessionId: "s3",
  });
  assert.deepEqual(out.newlyPrunedIds, [trR1]);
  assert.ok(!out.newlyPrunedIds.includes(trRFar));
  assert.ok(!out.newlyPrunedIds.includes(trRFail));
  assert.match(String(out.edits[0]!.replacement?.content), /stale read omitted.*superseded by later edit/);
});

test("bash masking reuses native details.fullOutputPath, spills when absent, and degrades gracefully on unwritable dir", () => {
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-spill-test-"));
  const sm = createSession("/repo");
  sm.appendMessage(makeUser("run"));
  sm.appendMessage(makeAssistant({
    toolCalls: [
      makeToolCall("bNative", "bash", { command: "npm test" }),
      makeToolCall("bSpill", "bash", { command: "git log -p" }),
    ],
    usage: { cacheRead: 0, cacheWrite: 1000 },
  }));
  const trNative = sm.appendMessage(makeToolResult({
    toolCallId: "bNative",
    toolName: "bash",
    text: repeatTokens(2500, "native"),
    details: { fullOutputPath: "/tmp/native-bash.log" },
  }));
  const rawSpillText = repeatTokens(2500, "custom");
  const trSpill = sm.appendMessage(makeToolResult({
    toolCallId: "bSpill",
    toolName: "bash",
    text: rawSpillText,
  }));
  sm.appendMessage(makeAssistant({ text: "t1", usage: { cacheRead: 0, cacheWrite: 1000 } }));
  sm.appendMessage(makeAssistant({ text: "t2", usage: { cacheRead: 0, cacheWrite: 1000 } }));

  const out = planL1Prune({
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: coldConfig({ spillDir }),
    cwd: "/repo",
    sessionId: "sess-a",
  });
  assert.deepEqual(out.newlyPrunedIds, [trNative, trSpill]);
  const nativeContent = String(out.edits.find((e) => e.targetId === trNative)!.replacement!.content);
  assert.match(nativeContent, /Full output: \/tmp\/native-bash\.log/);
  const spillContent = String(out.edits.find((e) => e.targetId === trSpill)!.replacement!.content);
  const expectedPath = path.join(spillDir, "sess-a", `${trSpill}.log`);
  assert.ok(spillContent.includes(expectedPath));
  assert.equal(fs.readFileSync(expectedPath, "utf8"), rawSpillText);

  // Unwritable spillDir (a regular file blocking mkdir)
  const blocker = path.join(spillDir, "blocked");
  fs.writeFileSync(blocker, "x");
  const degraded = planL1Prune({
    contextEntries: sm.buildSessionProjection().entries,
    state: createEmptyState(),
    config: coldConfig({ spillDir: path.join(blocker, "nested") }),
    cwd: "/repo",
    sessionId: "sess-b",
  });
  const degradedContent = String(degraded.edits.find((e) => e.targetId === trSpill)!.replacement!.content);
  assert.match(degradedContent, /bash output trimmed/);
  assert.ok(!degradedContent.includes("Full output:"));
  fs.rmSync(spillDir, { recursive: true, force: true });
});

test("batch gate defers on warm cache below minBatchSaveTokens and piggyback on warm cache respects piggybackAfterIndex", () => {
  const sm = createSession("/repo");
  sm.appendMessage(makeUser("go"));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "grep", { pattern: "early" })], usage: { cacheRead: 5000, cacheWrite: 0 }, timestamp: 1000 }));
  const trEarly = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "grep", text: repeatTokens(2500) }));
  sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c2", "grep", { pattern: "after" })], usage: { cacheRead: 6000, cacheWrite: 0 }, timestamp: 2000 }));
  const trAfter = sm.appendMessage(makeToolResult({ toolCallId: "c2", toolName: "grep", text: repeatTokens(2500) }));
  sm.appendMessage(makeAssistant({ text: "t1", usage: { cacheRead: 7000, cacheWrite: 0 }, timestamp: 3000 }));
  sm.appendMessage(makeAssistant({ text: "t2", usage: { cacheRead: 8000, cacheWrite: 0 }, timestamp: 4000 }));

  const entries = sm.buildSessionProjection().entries;
  const deferred = planL1Prune({
    contextEntries: entries,
    state: createEmptyState(),
    config: coldConfig({ minBatchSaveTokens: 20_000 }),
    cwd: "/repo",
    sessionId: "s5",
  });
  assert.equal(deferred.reason, "none");
  assert.equal(deferred.edits.length, 0);

  const minBatch = planL1Prune({
    contextEntries: entries,
    state: createEmptyState(),
    config: coldConfig({ minBatchSaveTokens: 4_000 }),
    cwd: "/repo",
    sessionId: "s5",
  });
  assert.equal(minBatch.reason, "min-batch");
  assert.deepEqual(minBatch.newlyPrunedIds, [trEarly, trAfter]);

  const trEarlyIdx = entries.findIndex((pe) => pe.sourceEntry.id === trEarly);
  const piggy = planL1Prune({
    contextEntries: entries,
    state: createEmptyState(),
    config: coldConfig({ minBatchSaveTokens: 20_000 }),
    cwd: "/repo",
    sessionId: "s5",
    piggybackAfterIndex: trEarlyIdx,
  });
  assert.equal(piggy.reason, "piggyback");
  assert.deepEqual(piggy.newlyPrunedIds, [trAfter]);
});
