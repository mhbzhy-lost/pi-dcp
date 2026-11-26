import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/types.ts";

test("package.json declares pi.extensions pointing to ./index.ts and type module", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(pkg.name, "@mhbzhy-lost/pi-dcp");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.pi, { extensions: ["./index.ts"] });
  assert.equal(pkg.dependencies, undefined);
});

test("loadConfig returns DEFAULT_CONFIG when no config files exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-cfg-empty-"));
  const warnings: string[] = [];
  const cfg = loadConfig(dir, { agentDir: path.join(dir, "agent"), warn: (m) => warnings.push(m) });
  assert.deepEqual(cfg, DEFAULT_CONFIG);
  assert.equal(warnings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfig merges agentDir/dcp.json and cwd/.pi/dcp.json with project overriding global", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-cfg-merge-"));
  const agentDir = path.join(dir, "agent");
  const projDir = path.join(dir, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "dcp.json"),
    JSON.stringify({ tailProtectTurns: 8, minBatchSaveTokens: 15000, compress: { nudgePercent: 70 } }),
  );
  fs.writeFileSync(
    path.join(projDir, ".pi", "dcp.json"),
    JSON.stringify({ tailProtectTurns: 4, compress: { minFoldTokens: 5000 } }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig(projDir, { agentDir, warn: (m) => warnings.push(m) });
  assert.equal(cfg.tailProtectTurns, 4);
  assert.equal(cfg.minBatchSaveTokens, 15000);
  assert.equal(cfg.compress.nudgePercent, 70);
  assert.equal(cfg.compress.minFoldTokens, 5000);
  assert.equal(cfg.compress.maxRetentionRatio, DEFAULT_CONFIG.compress.maxRetentionRatio);
  assert.equal(warnings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfig warns and falls back to defaults on malformed JSON, unknown keys, or out-of-range numbers without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dcp-cfg-bad-"));
  const agentDir = path.join(dir, "agent");
  const projDir = path.join(dir, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "dcp.json"), "{ invalid json");
  fs.writeFileSync(
    path.join(projDir, ".pi", "dcp.json"),
    JSON.stringify({
      bogusKey: true,
      tailProtectTurns: -5,
      minBatchSaveTokens: 12000,
      compress: { maxRetentionRatio: 1.5, unknownSub: 1, nudgePercent: 80 },
    }),
  );
  const warnings: string[] = [];
  const cfg = loadConfig(projDir, { agentDir, warn: (m) => warnings.push(m) });
  assert.equal(cfg.minBatchSaveTokens, 12000);
  assert.equal(cfg.tailProtectTurns, DEFAULT_CONFIG.tailProtectTurns);
  assert.equal(cfg.compress.maxRetentionRatio, DEFAULT_CONFIG.compress.maxRetentionRatio);
  assert.equal(cfg.compress.nudgePercent, 80);
  assert.ok(warnings.length >= 4, `expected >= 4 warnings, got ${warnings.length}: ${warnings.join("; ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

import { STATE_CUSTOM_TYPE, type DcpStateData } from "../src/types.ts";
import {
  buildToolCallIndex,
  countAssistantTurnsSince,
  detectCacheStatus,
  reconstructState,
  sanitizeContextEditDrafts,
} from "../src/state.ts";
import { createSession, makeAssistant, makeToolCall, makeToolResult, makeUser } from "./helpers.ts";

test("reconstructState returns empty state on fresh session and resets after compaction entry", () => {
  const sm = createSession();
  const u1 = sm.appendMessage(makeUser("hello"));
  assert.deepEqual(reconstructState(sm.getBranch()), {
    version: 1,
    lastFoldEndEntryId: null,
    foldTurnEntryIds: [],
    prunedEntryIds: [],
    foldCount: 0,
    lastNudgeEntryId: null,
  });

  const saved: DcpStateData = {
    version: 1,
    lastFoldEndEntryId: u1,
    foldTurnEntryIds: [u1],
    prunedEntryIds: [u1],
    foldCount: 2,
    lastNudgeEntryId: u1,
  };
  sm.appendCustomEntry(STATE_CUSTOM_TYPE, saved);
  assert.equal(reconstructState(sm.getBranch()).foldCount, 2);

  sm.appendCompaction("summary", u1, 5000);
  const afterCompact = reconstructState(sm.getBranch());
  assert.equal(afterCompact.lastFoldEndEntryId, null);
  assert.equal(afterCompact.foldCount, 0);
  assert.deepEqual(afterCompact.prunedEntryIds, []);
  assert.equal(afterCompact.lastNudgeEntryId, null);
});

test("reconstructState follows active branch after /tree branch switch", () => {
  const sm = createSession();
  const u1 = sm.appendMessage(makeUser("root"));
  const a1 = sm.appendMessage(makeAssistant({ text: "a1" }));
  sm.appendCustomEntry(STATE_CUSTOM_TYPE, {
    version: 1,
    lastFoldEndEntryId: a1,
    foldTurnEntryIds: [a1],
    prunedEntryIds: [a1],
    foldCount: 1,
    lastNudgeEntryId: a1,
  } satisfies DcpStateData);
  const leafA = sm.getLeafId()!;

  sm.branch(u1);
  sm.appendMessage(makeAssistant({ text: "branchB" }));
  assert.equal(reconstructState(sm.getBranch()).foldCount, 0);

  sm.branch(leafA);
  const restored = reconstructState(sm.getBranch());
  assert.equal(restored.foldCount, 1);
  assert.equal(restored.lastFoldEndEntryId, a1);
  assert.equal(restored.lastNudgeEntryId, a1);
});

test("detectCacheStatus marks cold on cacheRead===0&&cacheWrite>0 or TTL gap, warm/unknown on non-reporting provider", () => {
  const sm = createSession();
  sm.appendMessage(makeUser("u1"));
  sm.appendMessage(makeAssistant({ text: "a1", usage: { cacheRead: 0, cacheWrite: 0 }, timestamp: 1000 }));
  sm.appendMessage(makeAssistant({ text: "a2", usage: { cacheRead: 0, cacheWrite: 0 }, timestamp: 2000 }));
  assert.equal(detectCacheStatus(sm.buildSessionProjection().entries, 300_000).isCold, false);

  const smColdWrite = createSession();
  smColdWrite.appendMessage(makeUser("u1"));
  smColdWrite.appendMessage(makeAssistant({ text: "a1", usage: { cacheRead: 0, cacheWrite: 5000 }, timestamp: 1000 }));
  smColdWrite.appendMessage(makeAssistant({ text: "a2", usage: { cacheRead: 0, cacheWrite: 6000 }, timestamp: 2000 }));
  assert.equal(detectCacheStatus(smColdWrite.buildSessionProjection().entries, 300_000).isCold, true);

  const smTtl = createSession();
  smTtl.appendMessage(makeUser("u1"));
  smTtl.appendMessage(makeAssistant({ text: "a1", usage: { cacheRead: 4000, cacheWrite: 0 }, timestamp: 1000 }));
  smTtl.appendMessage(makeAssistant({ text: "a2", usage: { cacheRead: 4000, cacheWrite: 0 }, timestamp: 400_000 }));
  assert.equal(detectCacheStatus(smTtl.buildSessionProjection().entries, 300_000).isCold, true);
});

test("sanitizeContextEditDrafts filters invalid/omitted targets and prefers null over non-null on duplicate targetId", () => {
  const sm = createSession();
  const u1 = sm.appendMessage(makeUser("u1"));
  const a1 = sm.appendMessage(makeAssistant({ toolCalls: [makeToolCall("c1", "read", { path: "a.ts" })] }));
  const tr1 = sm.appendMessage(makeToolResult({ toolCallId: "c1", toolName: "read", text: "abc" }));
  const customId = sm.appendCustomEntry("other", { x: 1 });
  const omittedUser = sm.appendMessage(makeUser("already omitted"));
  sm.appendContextEdit(omittedUser, null);
  const projection = sm.buildSessionProjection().entries;

  const { byCallId, resultEntryIdsByCallId } = buildToolCallIndex(projection);
  assert.equal(byCallId.get("c1")?.assistantEntryId, a1);
  assert.deepEqual(resultEntryIdsByCallId.get("c1"), [tr1]);
  assert.equal(countAssistantTurnsSince(projection, [u1]), 1);

  const sanitized = sanitizeContextEditDrafts(
    [
      { type: "context_edit", targetId: customId, replacement: null },
      { type: "context_edit", targetId: "nonexistent", replacement: null },
      { type: "context_edit", targetId: omittedUser, replacement: { content: "resurrect?" } },
      { type: "context_edit", targetId: tr1, replacement: null },
      { type: "context_edit", targetId: tr1, replacement: { content: "placeholder" } },
      { type: "context_edit", targetId: u1, replacement: { content: "edited" } },
    ],
    projection,
  );
  assert.deepEqual(sanitized, [
    { type: "context_edit", targetId: tr1, replacement: null },
    { type: "context_edit", targetId: u1, replacement: { content: "edited" } },
  ]);
});
