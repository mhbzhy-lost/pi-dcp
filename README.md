# `@mhbzhy-lost/pi-dcp`

Minimal, Pi 1.6.1-native tail-local context pruning and monotone folding extension built on Pi's `context_edit` session entries and `turn_end` boundary drafts.

## Design

- **Zero sidecar / zero `context` hook / zero O(n²) alignment**: all edits are branch-native `context_edit` entries, and state persists as `custom` (`pi-dcp:state`) entries in the session tree. Pi's native compaction, `/tree` branching, and threshold checks stay in sync automatically.
- **Module A (L1 — Deterministic Cache-Aware Pruning)**:
  - Protects the recent tail window (`tailProtectTurns: 6`, `tailProtectTokens: 20000`), all `isError` tool results, `protectedTools` (`["subagent", "compress"]`), and image-bearing tool results.
  - Evicts stale earlier `read` outputs superseded by a later successful `edit`, `write`, or covering `read` (respecting Pi's 2000-line unbounded `read` cap).
  - Masks oversized non-error tool outputs (`>= 2000` tokens); for `bash`, reuses Pi's native `details.fullOutputPath` when present and otherwise spills full output to a temp file so the model can inspect it via `read`.
  - Defers edits when cache is warm until batch savings reach `minBatchSaveTokens` (`20000`), or flushes opportunistically when cache is cold (`>= 2000` tokens) or piggybacking on a fold.
- **Module B (L2 — Monotone Tail Folding via `compress`)**:
  - Registers `compress` (`exposure: "model-only"`, parameters `{ topic, summary, keepRecentTurns? }`).
  - Pins both the initial user prompt (`U1`) and the active latest user prompt (`U2`) verbatim.
  - Emits pure `replacement: null` edits for folded entries while letting the `compress` tool call carry the structured summary once — zero summary duplication and strict role alternation across Anthropic, Gemini, and OpenAI.
  - Enforces atomic tool transactions, monotone fold boundaries (never re-folding prior folds), minimum fold size (`3000` tokens), and anti-bloat ratio (`< 0.7`).
  - Uses incremental `systemPromptOptions.sections["dcp"]` (never replaces `systemPrompt`) and optional tail `custom_message` soft nudges (`display: false`).

## Configuration (Optional)

Defaults work out of the box. Optional overrides in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/dcp.json` and `<cwd>/.pi/dcp.json` (project overrides global; invalid JSON or keys warn and fall back to defaults without disabling the extension).

## Development

```bash
npm install
npm run typecheck
npm test
npm run check:loc
```
