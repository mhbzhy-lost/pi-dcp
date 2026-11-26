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
  enabled: true, tailProtectTurns: 6, tailProtectTokens: 20_000, oversizedToolTokens: 2_000,
  minStaleReadTokens: 200, minBatchSaveTokens: 20_000, coldCacheMinSaveTokens: 2_000,
  cacheTtlMs: 300_000, spillBashOutput: true, protectedTools: ["subagent", "compress"],
  compress: { enabled: true, minFoldTokens: 3_000, maxRetentionRatio: 0.7, nudgePercent: 65, nudgeMinTurns: 6 },
};

export function createEmptyState(): DcpStateData {
  return { version: 1, lastFoldEndEntryId: null, foldTurnEntryIds: [], prunedEntryIds: [], foldCount: 0, lastNudgeEntryId: null };
}

const TOP_NUMS: Record<string, [number, number]> = {
  tailProtectTurns: [0, 100], tailProtectTokens: [0, 500_000], oversizedToolTokens: [100, 500_000],
  minStaleReadTokens: [50, 100_000], minBatchSaveTokens: [500, 500_000], coldCacheMinSaveTokens: [0, 500_000],
  cacheTtlMs: [1_000, 86_400_000],
};
const TOP_KEYS = new Set(["enabled", "spillBashOutput", "spillDir", "protectedTools", "compress", ...Object.keys(TOP_NUMS)]);
const CMP_NUMS: Record<string, [number, number]> = {
  minFoldTokens: [200, 500_000], maxRetentionRatio: [0.05, 0.95], nudgePercent: [10, 99], nudgeMinTurns: [1, 100],
};

function applyNums(target: Record<string, unknown>, obj: Record<string, unknown>, specs: Record<string, [number, number]>, prefix: string, src: string, warn: (m: string) => void): void {
  for (const [k, [min, max]] of Object.entries(specs)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) target[k] = v;
    else warn(`[pi-dcp] Ignoring invalid ${prefix}${k} in ${src}: ${String(v)}`);
  }
}

function applyLayer(target: DcpConfig, raw: unknown, src: string, warn: (m: string) => void): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { warn(`[pi-dcp] Ignoring non-object config in ${src}`); return; }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!TOP_KEYS.has(k)) warn(`[pi-dcp] Unknown config key "${k}" in ${src}`);
  for (const k of ["enabled", "spillBashOutput"] as const) {
    if (obj[k] !== undefined) typeof obj[k] === "boolean" ? (target[k] = obj[k]) : warn(`[pi-dcp] Invalid ${k} in ${src}`);
  }
  if (obj.spillDir !== undefined) typeof obj.spillDir === "string" && obj.spillDir.trim() ? (target.spillDir = obj.spillDir) : warn(`[pi-dcp] Invalid spillDir in ${src}`);
  if (obj.protectedTools !== undefined) {
    if (Array.isArray(obj.protectedTools) && obj.protectedTools.every((t) => typeof t === "string")) target.protectedTools = [...obj.protectedTools];
    else warn(`[pi-dcp] Invalid protectedTools in ${src}`);
  }
  applyNums(target as unknown as Record<string, unknown>, obj, TOP_NUMS, "", src, warn);
  if (obj.compress === undefined) return;
  if (!obj.compress || typeof obj.compress !== "object" || Array.isArray(obj.compress)) { warn(`[pi-dcp] Invalid compress section in ${src}`); return; }
  const c = obj.compress as Record<string, unknown>;
  for (const k of Object.keys(c)) if (k !== "enabled" && !(k in CMP_NUMS)) warn(`[pi-dcp] Unknown config key "compress.${k}" in ${src}`);
  if (c.enabled !== undefined) typeof c.enabled === "boolean" ? (target.compress.enabled = c.enabled) : warn(`[pi-dcp] Invalid compress.enabled in ${src}`);
  applyNums(target.compress as unknown as Record<string, unknown>, c, CMP_NUMS, "compress.", src, warn);
}

export function loadConfig(cwd: string, options?: { agentDir?: string; warn?: (msg: string) => void }): DcpConfig {
  const warn = options?.warn ?? ((m: string) => console.warn(m));
  const agentDir = options?.agentDir ?? getAgentDir();
  const cfg: DcpConfig = { ...DEFAULT_CONFIG, protectedTools: [...DEFAULT_CONFIG.protectedTools], compress: { ...DEFAULT_CONFIG.compress } };
  for (const file of [path.join(agentDir, "dcp.json"), path.join(cwd, ".pi", "dcp.json")]) {
    if (!fs.existsSync(file)) continue;
    try { applyLayer(cfg, JSON.parse(fs.readFileSync(file, "utf8")), file, warn); }
    catch (err) { warn(`[pi-dcp] Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return cfg;
}
