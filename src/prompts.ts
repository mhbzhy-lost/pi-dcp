import type { PendingCompressPlan } from "./types.ts";

export const COMPRESS_SYSTEM_SECTION = `## Context Folding (compress)

Use the \`compress\` tool once when a coherent exploration or implementation phase is genuinely closed and its raw tool outputs are no longer needed verbatim.
- Your \`summary\` stays in context inside the \`compress\` call itself; earlier messages in the folded span are omitted cleanly.
- Structure \`summary\` with four concise parts: (1) Goal/Intent, (2) Key Findings & Decisions, (3) Exact File Paths & Symbols, (4) Open Items/Constraints.
- Do not call \`compress\` repeatedly for tiny fragments or while raw outputs are still needed for active edits.
- Pass \`keepRecentTurns\` (0-10, default 0) only if you want the most recent N completed turns before this call kept verbatim.`;

export function formatStaleReadPlaceholder(rawPath: string, range: string, lines: number, tokens: number, byTool: string): string {
  return `[dcp: stale read omitted — ${rawPath}${range} (${lines} lines, ~${tokens} tok), superseded by later ${byTool}]`;
}

export function formatBashPlaceholder(cmd: string, lines: number, tokens: number, fullOutputPath?: string): string {
  const shortCmd = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
  const base = `[dcp: bash output trimmed — \`${shortCmd}\` (${lines} lines, ~${tokens} tok)`;
  return fullOutputPath ? `${base}. Full output: ${fullOutputPath} (use read to inspect)]` : `${base}]`;
}

export function formatToolPlaceholder(toolName: string, detail: string, lines: number, tokens: number): string {
  const suffix = toolName === "read" ? ". Re-read file if needed" : "";
  return `[dcp: ${toolName} output trimmed — ${detail} (${lines} lines, ~${tokens} tok)${suffix}]`;
}

export function formatNudgeMessage(percent: number): string {
  return `[dcp] Context is at ~${Math.round(percent)}%. If the current exploration or implementation phase is closed, call \`compress\` once to fold it; otherwise continue working.`;
}

export function formatFoldResult(plan: PendingCompressPlan): string {
  const scopeNote = plan.keepRecentTurns > 0 ? ` prior to recent ${plan.keepRecentTurns} kept turn(s)` : "";
  const header = `[DCP Fold #${plan.foldNumber}: ${plan.topic}] Folded ${plan.foldedEntryIds.length} entries${scopeNote} (~${plan.compressedTokens} -> ~${plan.summaryTokens} tokens)`;
  return plan.preservedUsersText ? `${header}\n\n### Preserved User Prompts\n${plan.preservedUsersText}` : header;
}
