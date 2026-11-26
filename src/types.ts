import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const STATE_CUSTOM_TYPE = "pi-dcp:state" as const;
export const NUDGE_CUSTOM_TYPE = "pi-dcp:nudge" as const;

export interface CompressConfig {
  enabled: boolean;
  minFoldTokens: number;
  maxRetentionRatio: number;
  nudgePercent: number;
  nudgeMinTurns: number;
}

export interface DcpConfig {
  enabled: boolean;
  tailProtectTurns: number;
  tailProtectTokens: number;
  oversizedToolTokens: number;
  minStaleReadTokens: number;
  minBatchSaveTokens: number;
  coldCacheMinSaveTokens: number;
  cacheTtlMs: number;
  spillBashOutput: boolean;
  spillDir?: string;
  protectedTools: string[];
  compress: CompressConfig;
}

export interface DcpStateData {
  version: 1;
  lastFoldEndEntryId: string | null;
  foldTurnEntryIds: string[];
  prunedEntryIds: string[];
  foldCount: number;
  lastNudgeEntryId: string | null;
}

export interface PendingCompressPlan {
  topic: string;
  summary: string;
  foldedEntryIds: string[];
  endEntryId: string;
  foldedAfterLastUser: boolean;
  keepRecentTurns: number;
  preservedUsersText: string;
  compressedTokens: number;
  summaryTokens: number;
  foldNumber: number;
}

export const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  tailProtectTurns: 6,
  tailProtectTokens: 20_000,
  oversizedToolTokens: 2_000,
  minStaleReadTokens: 200,
  minBatchSaveTokens: 20_000,
  coldCacheMinSaveTokens: 2_000,
  cacheTtlMs: 300_000,
  spillBashOutput: true,
  protectedTools: ["subagent", "compress"],
  compress: {
    enabled: true,
    minFoldTokens: 3_000,
    maxRetentionRatio: 0.7,
    nudgePercent: 65,
    nudgeMinTurns: 6,
  },
};

export function createEmptyState(): DcpStateData {
  return {
    version: 1,
    lastFoldEndEntryId: null,
    foldTurnEntryIds: [],
    prunedEntryIds: [],
    foldCount: 0,
    lastNudgeEntryId: null,
  };
}

const TOP_KEYS = new Set([
  "enabled", "tailProtectTurns", "tailProtectTokens", "oversizedToolTokens",
  "minStaleReadTokens", "minBatchSaveTokens", "coldCacheMinSaveTokens",
  "cacheTtlMs", "spillBashOutput", "spillDir", "protectedTools", "compress",
]);
const COMPRESS_KEYS = new Set([
  "enabled", "minFoldTokens", "maxRetentionRatio", "nudgePercent", "nudgeMinTurns",
]);

function checkNum(val: unknown, min: number, max: number, label: string, warn: (m: string) => void): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && val >= min && val <= max) return val;
  warn(`[pi-dcp] Ignoring invalid ${label}: ${String(val)}`);
  return undefined;
}

function applyLayer(target: DcpConfig, raw: unknown, source: string, warn: (m: string) => void): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`[pi-dcp] Ignoring non-object config in ${source}`);
    return;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.has(key)) warn(`[pi-dcp] Unknown config key "${key}" in ${source}`);
  }
  if (obj.enabled !== undefined) typeof obj.enabled === "boolean" ? (target.enabled = obj.enabled) : warn(`[pi-dcp] Invalid enabled in ${source}`);
  if (obj.spillBashOutput !== undefined) typeof obj.spillBashOutput === "boolean" ? (target.spillBashOutput = obj.spillBashOutput) : warn(`[pi-dcp] Invalid spillBashOutput in ${source}`);
  if (obj.spillDir !== undefined) typeof obj.spillDir === "string" && obj.spillDir.trim() ? (target.spillDir = obj.spillDir) : warn(`[pi-dcp] Invalid spillDir in ${source}`);
  if (obj.protectedTools !== undefined) {
    if (Array.isArray(obj.protectedTools) && obj.protectedTools.every((t) => typeof t === "string")) target.protectedTools = [...obj.protectedTools];
    else warn(`[pi-dcp] Invalid protectedTools in ${source}`);
  }
  const numSpecs: Array<[keyof DcpConfig, number, number]> = [
    ["tailProtectTurns", 0, 100], ["tailProtectTokens", 0, 500_000], ["oversizedToolTokens", 100, 500_000],
    ["minStaleReadTokens", 50, 100_000], ["minBatchSaveTokens", 500, 500_000], ["coldCacheMinSaveTokens", 0, 500_000],
    ["cacheTtlMs", 1_000, 86_400_000],
  ];
  for (const [k, min, max] of numSpecs) {
    if (obj[k] !== undefined) {
      const v = checkNum(obj[k], min, max, `${k} (${source})`, warn);
      if (v !== undefined) (target[k] as number) = v;
    }
  }
  if (obj.compress !== undefined) {
    if (!obj.compress || typeof obj.compress !== "object" || Array.isArray(obj.compress)) {
      warn(`[pi-dcp] Invalid compress section in ${source}`);
      return;
    }
    const c = obj.compress as Record<string, unknown>;
    for (const key of Object.keys(c)) {
      if (!COMPRESS_KEYS.has(key)) warn(`[pi-dcp] Unknown config key "compress.${key}" in ${source}`);
    }
    if (c.enabled !== undefined) typeof c.enabled === "boolean" ? (target.compress.enabled = c.enabled) : warn(`[pi-dcp] Invalid compress.enabled in ${source}`);
    const cSpecs: Array<[keyof CompressConfig, number, number]> = [
      ["minFoldTokens", 200, 500_000], ["maxRetentionRatio", 0.05, 0.95], ["nudgePercent", 10, 99], ["nudgeMinTurns", 1, 100],
    ];
    for (const [k, min, max] of cSpecs) {
      if (c[k] !== undefined) {
        const v = checkNum(c[k], min, max, `compress.${k} (${source})`, warn);
        if (v !== undefined) (target.compress[k] as number) = v;
      }
    }
  }
}

export function loadConfig(cwd: string, options?: { agentDir?: string; warn?: (msg: string) => void }): DcpConfig {
  const warn = options?.warn ?? ((msg: string) => console.warn(msg));
  const agentDir = options?.agentDir ?? getAgentDir();
  const cfg: DcpConfig = { ...DEFAULT_CONFIG, protectedTools: [...DEFAULT_CONFIG.protectedTools], compress: { ...DEFAULT_CONFIG.compress } };
  for (const file of [path.join(agentDir, "dcp.json"), path.join(cwd, ".pi", "dcp.json")]) {
    if (!fs.existsSync(file)) continue;
    try {
      applyLayer(cfg, JSON.parse(fs.readFileSync(file, "utf8")), file, warn);
    } catch (err) {
      warn(`[pi-dcp] Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cfg;
}
