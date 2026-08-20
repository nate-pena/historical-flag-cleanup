# historical-flag-cleanup

A standalone tool that closes EnergyCAP audit flags sitting on **historical bills** — bills that
arrived in EnergyCAP 61+ calendar days after their own date — when the flag is assigned **only to
ENC staff**. Historical bills are out of scope for ENC to work, so these flags are internal
housekeeping, closed with an explanatory comment.

## The rule, in plain English

A flag qualifies to close only when ALL of these are true, checked **live** at the moment of writing:

1. The bill's **statement date** is 61+ calendar days before the bill's **upload date** into
   EnergyCAP. (No statement date? The **service-period end date** is used instead.)
2. The flag is **still open** in EnergyCAP right now.
3. **Every** assignee on the flag is EnergyCAP staff — matched by verified `@energycap.com`
   account (user id), never by display name. One customer assignee = untouchable.

Flags with **no assignee** are set aside for a human. Voided bills are skipped. Special-handling
customers (non-standard contracts) are **excluded by default**.

## How to run it

```bash
# 1) Always start with a dry run (default) — counts only, changes nothing:
node historical-cleanup.mjs --customers=all
node historical-cleanup.mjs --customers=<key1>,<key2>      # keys from the flag-ops roster

# 2) Review the numbers, then execute:
node historical-cleanup.mjs --customers=<key1>,<key2> --live
```

By default every run is **thorough** — it live-checks every open bill, so the count is exact. That is
the only mode that ever drives a real cleanup.

Options:
- `--fast` — quick **lower-bound estimate** only (checks just the bills the flag list already tags as
  ENC-assigned; can miss some). Handy for a rough "how big is this" across many customers. **Cannot be
  combined with `--live`** — a real cleanup is always exhaustive.
- `--include-special` — include special-handling customers (only after confirming the policy applies)
- `--days N` — change the 61-day threshold (whole number ≥ 14; the tool aborts on anything else)

## What --live actually does (the safety design)

- **Canary first**: ~25 flags, fully verified, before anything else.
- **Chunks of 250** after that, each verified before the next starts.
- **Live re-verification per flag** the instant before writing: still open, still ENC-only, **and the
  bill still historical under the hardened date rule** (a bill whose only "historical" evidence was an
  implausible statement date is re-checked by its service-end date and dropped if it no longer
  qualifies). Anything that changed since the measurement is skipped and counted, never written.
- **Assignees preserved** on every resolve; comment:
  `Historical bill — out of scope for ENC (61+ days old at upload)`.
- **Verify-after-write** on every flag; **abort on the first anomaly** — an abort halts the ENTIRE
  run (remaining customers are NOT processed), so re-run explicitly after resolving the cause.
- **Post-run sample**: 10 bills re-read independently; reports `still-open` (want 0) and
  `unverified` (sample reads that failed — not counted as a pass).
- Every run writes its full plan + results + summary JSON under a timestamped `runs/<datetime>/`
  (gitignored; append-only — a re-run never overwrites a prior run's audit trail).

### A note on "dry run"

A dry run changes **no flag and no bill** — it only reads. It does, however, create and then delete
a few short-lived server-side query lists (that's how EnergyCAP pages through unresolved flags). So
"dry run" means *no changes to your data*, not *zero server writes of any kind*.

## Requirements

- A local checkout of the `flag-ops` repo (default `~/code/flag-ops`, override with `FLAG_OPS_DIR`).
  Credentials stay there (`.env` — this tool never reads or prints keys itself), along with the
  customer roster, the EnergyCAP API client, and the ENC staff-roster logic.
- Node 22+ (uses `import.meta.dirname`).

## For Claude

This repo ships a skill (`SKILL.md`). Once installed at
`~/.claude/skills/historical-flag-cleanup/SKILL.md`, it lets you say **"run the historical flag
cleanup"** in any Claude Code session — Claude dry-runs, shows you the counts, and only executes
with your explicit approval.

Install (one time):

```bash
mkdir -p ~/.claude/skills/historical-flag-cleanup
cp SKILL.md ~/.claude/skills/historical-flag-cleanup/SKILL.md
```

---

## Sibling tool: `pre-golive-cleanup.mjs`

Same safety spine, **different qualifying rule, and it resolves rather than unassigns**. It closes
flags that were raised BEFORE a customer's go-live date and are assigned only to ENC staff — out of
scope because the flag pre-dates the engagement.

```bash
node pre-golive-cleanup.mjs --customer=ge-aerospace --cutoff=2025-05-06          # dry run
node pre-golive-cleanup.mjs --customer=ge-aerospace --cutoff=2025-05-06 --live   # execute
```

A flag qualifies only when all of these hold, re-verified live at the moment of writing:

1. Its **own earliest "Flagged" event** is strictly before the cutoff. ⚠ The saved-list
   "Flag Created" column is BILL-scoped and is never used for dating; an issue with no readable
   Flagged event is set aside rather than resolved.
2. It is open.
3. It has at least one assignee and **every** assignee is ENC staff, matched by userId against the
   live per-database roster. One customer assignee means it is never touched; an empty assignee list
   is set aside for a human.

Dry-run by default, one explicit customer per run, an explicit cutoff required, live re-verification
of every issue immediately before writing, assignees preserved, canary of 25 then chunks of 250,
verify-after-write, abort-on-anomaly. It reads credentials through the Flag Ops directory
(`FLAG_OPS_DIR`, default `~/code/flag-ops`) and never reads `.env` or prints a key itself.

Run 2026-08-01: GE Aerospace 0 · Ventek 19 · Toppan 78.
