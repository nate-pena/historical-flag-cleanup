---
name: historical-flag-cleanup
description: Close EnergyCAP audit flags on HISTORICAL bills (arrived 61+ days after their own date) that are assigned only to ENC staff, across any or all customers. Dry-run-first, canary-then-chunks, live re-verification per flag, verify-after-write, abort-on-anomaly. Use when the user says "run the historical flag cleanup", "historical dump flag fix", "close historical flags for <customer>", or "which customers have historical flag backlogs". Policy: ENC is not responsible for flags on bills 61+ calendar days old at upload.
---

# Historical Flag Cleanup

Standalone tool at `~/code/historical-flag-cleanup/historical-cleanup.mjs` (repo: nate-pena/historical-flag-cleanup). Requires the flag-ops checkout at `~/code/flag-ops` (or `FLAG_OPS_DIR`) for credentials/API client — never read or print `.env` or key values.

## Procedure (follow exactly)

1. **Dry run first — always, and thorough (the default).**
   `node ~/code/historical-flag-cleanup/historical-cleanup.mjs --customers=<keys|all>`
   Runs default to THOROUGH (every open bill live-checked = the exact count) — this is required
   for any customer run; never pass `--fast` for a real measurement or cleanup (`--fast` is a
   rough lower-bound estimate only and is blocked from `--live`). Customer keys come from the
   flag-ops roster (`databases.json` keys). The run prints a per-customer count of qualifying flags
   and writes plan files under the tool's timestamped `runs/<datetime>/`.
2. **Report the counts to the user in plain English** (per customer + total) and **ask for explicit
   approval** before executing. Never run `--live` without the user approving THAT run's numbers.
3. **Execute:** same command plus `--live`. It canaries ~25 flags, then chunks of 250, re-verifies
   every flag live (still open + still ENC-only by userId + still historical) at write time,
   preserves assignees, verifies after every write, aborts on the first anomaly, and ends with a
   post-run sample.
4. **Report results per customer**: resolved / skipped / failures. From the post-run sample you MUST
   report BOTH numbers: `sampleStillOpen` (must be 0) AND `sampleUnverified` (sample bills whose
   re-read failed). A non-zero `sampleUnverified` means the sample did NOT clear those bills — it is
   NOT an all-clear; say so plainly and never report "sample clear / all good" while it is non-zero.
   Say where the results JSON lives. If a run aborted, say exactly where and why — never continue
   past an abort.

## Guardrails

- Special-handling customers (the live list comes from flag-ops `specialhandling.mjs`) are
  **excluded by default**; include only with `--include-special` AND explicit user confirmation that
  the historical policy applies to them.
- The 61-day threshold is policy. `--days` exists for deliberate policy changes only — confirm with
  the user before using it.
- An abort halts the ENTIRE run (the first anomaly stops the whole customer loop; remaining
  customers are NOT processed). Report exactly which customer aborted and that later ones were
  skipped, then re-run the remaining customers explicitly after the cause is understood.
- This tool resolves flags only. It never voids bills, never changes assignees beyond preserving
  them, never touches customer-assigned or unassigned flags.
