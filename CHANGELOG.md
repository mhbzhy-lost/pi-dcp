# Changelog

## [1.0.0] - 2026-11-26

### Added

- Initial Pi 1.6.1-native tail-local context pruning and monotone folding extension built on `context_edit` session entries and `turn_end` boundary drafts.
- **L1 deterministic cache-aware pruning**: evicts stale superseded `read` outputs and masks oversized non-error tool outputs (reusing Pi's native `details.fullOutputPath` when present) while protecting the recent tail window, errors, images, and protected tools.
- **L2 monotone tail folding (`compress`)**: registers model-only `compress` tool with dual user-prompt anchoring (`U1`/`U2`), pure `replacement: null` folding, atomic tool transactions, minimum fold size, and anti-bloat guardrails.
- Branch-native state persistence via `custom` (`pi-dcp:state`) session entries and optional global/project `dcp.json` configuration.
