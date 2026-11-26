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
