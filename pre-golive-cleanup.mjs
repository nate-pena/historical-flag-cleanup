/**
 * pre-golive-cleanup — standalone tool (NOT part of the Flag Ops portal).
 * ────────────────────────────────────────────────────────────────────────────
 * RESOLVES EnergyCAP audit flag issues that were CREATED BEFORE a customer's go-live date and are
 * assigned ONLY to ENC staff. Out of scope for ENC: the flag pre-dates the engagement.
 *
 * Sibling of historical-cleanup.mjs (same safety spine, different qualifying rule, and this one
 * RESOLVES with a comment rather than unassigning).
 *
 * THE RULE
 *   A flag issue qualifies ONLY when ALL of these hold, re-verified live at the moment of writing:
 *     1. Its OWN earliest "Flagged" event is strictly BEFORE the cutoff date (the go-live date).
 *        The saved-list "Flag Created" column/filter is BILL-scoped and is NEVER used for dating.
 *        An issue with no readable Flagged event is SET ASIDE, never resolved.
 *     2. It is OPEN (flagIssueStatusId === 1).
 *     3. It has at least one assignee and EVERY assignee is ENC staff (@energycap.com, matched by
 *        userId against the live per-DB roster). Any customer assignee → NEVER touched.
 *        Empty-assignee issues → set aside for a human.
 *
 * USAGE
 *   node pre-golive-cleanup.mjs --customer=ge-aerospace --cutoff=2025-05-06            # DRY RUN
 *   node pre-golive-cleanup.mjs --customer=ge-aerospace --cutoff=2025-05-06 --live     # execute
 *   Options: --comment="..."   override the resolve comment (default below)
 *            --passes=N        enumeration passes to union (default 3; EnergyCAP paging is unstable)
 *
 * SAFETY (all non-negotiable):
 *   dry-run by default · one explicit customer per run · explicit cutoff required · per-issue date
 *   proof from the issue's own event history · live re-verification of every issue (still open,
 *   still ENC-only, still pre-cutoff) immediately before writing · assignees preserved ·
 *   canary 25 then chunks of 250 · verify-after-write on every issue · abort-on-anomaly ·
 *   post-run independent sample · full plan + results JSON written to ./runs/.
 *
 * DEPENDENCY: reads config/credentials and the API client from the local flag-ops checkout
 * (FLAG_OPS_DIR, default ~/code/flag-ops) so API keys stay in exactly one audited place. This tool
 * never reads .env itself and never prints a key.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FLAG_OPS = process.env.FLAG_OPS_DIR || join(homedir(), 'code', 'flag-ops');
const { getDatabase, listDatabaseKeys } = await import(join(FLAG_OPS, 'config.mjs'));
const { fetchUnresolvedFlagRows, getFlagIssuesForBillStrict, ecapFetch, pool } = await import(join(FLAG_OPS, 'ecap.mjs'));
const { getEncRoster } = await import(join(FLAG_OPS, 'encdir.mjs'));

// ── strict argument parsing: an unrecognized/malformed argument aborts the run ──────────────────
const KNOWN_FLAGS = new Set(['--live']);
const KNOWN_OPTS = new Set(['customer', 'cutoff', 'comment', 'passes']);
const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (KNOWN_FLAGS.has(a)) continue;
  const m = a.match(/^--([a-z-]+)=([\s\S]*)$/);
  if (m && KNOWN_OPTS.has(m[1])) { opts[m[1]] = m[2]; continue; }
  console.error(`Unrecognized argument: "${a}". Valid: --customer=<key> --cutoff=YYYY-MM-DD [--comment="..."] [--passes=N] [--live]`);
  process.exit(1);
}
const LIVE = argv.includes('--live');

const KEY = opts.customer;
if (!KEY) { console.error('--customer=<key> is required (never an implied default).'); process.exit(1); }
if (!listDatabaseKeys().includes(KEY)) { console.error(`Unknown customer key "${KEY}".`); process.exit(1); }

// The cutoff must be an explicit, well-formed, real calendar date. A typo here silently changes the
// scope of a bulk resolve, so it is validated hard rather than coerced.
const CUTOFF = String(opts.cutoff || '').trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF) || !Number.isFinite(Date.parse(CUTOFF + 'T00:00:00Z')) ||
    new Date(CUTOFF + 'T00:00:00Z').toISOString().slice(0, 10) !== CUTOFF) {
  console.error(`--cutoff must be a real date as YYYY-MM-DD (got "${opts.cutoff ?? ''}"). Flags created STRICTLY BEFORE this date qualify.`);
  process.exit(1);
}
if (CUTOFF >= new Date().toISOString().slice(0, 10)) {
  console.error(`--cutoff ${CUTOFF} is today or in the future — that would sweep the entire live backlog. Refusing.`);
  process.exit(1);
}

const COMMENT = opts.comment !== undefined ? opts.comment : 'out of scope, created prior to go live';
if (!COMMENT.trim()) { console.error('--comment must not be empty.'); process.exit(1); }

const PASSES = opts.passes === undefined ? 3 : Number(opts.passes);
if (!Number.isInteger(PASSES) || PASSES < 1 || PASSES > 10) { console.error('--passes must be a whole number 1–10.'); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const RUN_DIR = join(import.meta.dirname, 'runs', `pregolive-${KEY}-${stamp}`);
mkdirSync(RUN_DIR, { recursive: true });

console.log(`Mode: ${LIVE ? 'LIVE (will write)' : 'DRY RUN (no writes)'} · customer: ${KEY} · cutoff: before ${CUTOFF} · comment: "${COMMENT}"\n`);

// ── the qualifying rule ─────────────────────────────────────────────────────────────────────────

const FLAGGED_ACTION_ID = 1; // flagIssueAction 1 = "Flagged"

/**
 * The issue's OWN creation date, proven from its own event history.
 * Uses the EARLIEST "Flagged" event. Deliberately does NOT fall back to other event types: an
 * "Assigned"/"Comment" event can post-date creation, and dating a flag by a later event could only
 * ever make an in-scope flag look older than it is. Returns null when undecidable → set aside.
 */
function issueCreatedDate(issue) {
  const evs = Array.isArray(issue?.flagIssueEvents) ? issue.flagIssueEvents : [];
  const flagged = evs
    .filter((e) => e?.flagIssueAction?.flagIssueActionId === FLAGGED_ACTION_ID && e?.createdDate)
    .map((e) => String(e.createdDate))
    .sort();
  return flagged.length ? flagged[0] : null;
}

/** Strictly before the cutoff, compared on the date part only (timestamps are UTC). */
const isPreCutoff = (iso) => !!iso && String(iso).slice(0, 10) < CUTOFF;

/** The staff roster is the safety backbone: no roster → abort, never guess an assignee is ENC. */
async function requireRoster(dbc) {
  const roster = (await getEncRoster(dbc)) || (await getEncRoster(dbc, { force: true }));
  if (!roster?.list?.length) throw new Error('ENC roster unavailable — refusing to run (cannot verify assignees safely)');
  return roster;
}

/**
 * Classify one live issue against the whole rule. Single source of truth used by BOTH the planning
 * pass and the write-time re-gate, so the two can never drift apart.
 */
function classify(issue, encIds) {
  if (issue?.flagIssueStatus?.flagIssueStatusId !== 1) return { qualifies: false, reason: 'not-open' };
  const created = issueCreatedDate(issue);
  if (!created) return { qualifies: false, reason: 'no-flagged-event' };
  if (!isPreCutoff(created)) return { qualifies: false, reason: 'on-or-after-cutoff', created };
  const as = issue.assignees || [];
  if (!as.length) return { qualifies: false, reason: 'no-assignee', created };
  if (!as.every((a) => encIds.has(a.userId))) return { qualifies: false, reason: 'has-customer-assignee', created };
  return { qualifies: true, created, assigneeIds: as.map((a) => a.userId) };
}

// ── enumeration ─────────────────────────────────────────────────────────────────────────────────

/**
 * EnergyCAP's /data paging has no stable sort: rows repeat across pages and an equal number are
 * silently dropped, so ONE pass can miss bills while still looking complete. Union N passes.
 */
async function enumerateBills(dbc) {
  const issueIds = new Set(), billIds = new Set();
  const declared = [], dropped = [];
  // An individual pass being short is EXPECTED (that is the paging defect these passes exist to
  // absorb) — so a short pass is never fatal on its own. What must hold is that the UNION reaches
  // the server's own declared row count. Extra passes are run until it does.
  const MAX_PASSES = PASSES + 5;
  let p = 0, shortPasses = 0;
  while (p < MAX_PASSES) {
    const { rows, rawTotal, declaredTotal, incomplete } = await fetchUnresolvedFlagRows(dbc, { pageSize: 250 });
    if (incomplete) shortPasses++;
    // fetchUnresolvedFlagRows drops rows whose "Flag Status ID" column is 2. That column is
    // BILL-level, so in principle it could hide an open ISSUE on an otherwise-resolved bill.
    // Measure it rather than assume: anything dropped is reported and blocks the run.
    dropped.push((rawTotal ?? rows.length) - rows.length);
    if (declaredTotal) declared.push(declaredTotal);
    for (const r of rows) {
      if (r['Flag Issue ID']) issueIds.add(String(r['Flag Issue ID']));
      if (r['Bill ID']) billIds.add(r['Bill ID']);
    }
    p++;
    const target = declared.length ? Math.max(...declared) : null;
    console.log(`  pass ${p}: ${rows.length} rows${incomplete ? ' (SHORT)' : ''} (server declared ${declaredTotal ?? '?'}) → union now ${issueIds.size} issues / ${billIds.size} bills`);
    if (p >= PASSES && (target == null || issueIds.size >= target)) break;
  }
  const target = declared.length ? Math.max(...declared) : null;
  if (target != null && issueIds.size < target) {
    throw new Error(`after ${p} passes the union holds ${issueIds.size} open issues but the server declares ${target} — refusing to plan from an enumeration that is still missing rows`);
  }
  if (shortPasses) console.log(`  (${shortPasses} pass(es) came back short — absorbed by the union, which now matches the server's declared ${target})`);
  const totalDropped = dropped.reduce((a, b) => a + b, 0);
  if (totalDropped > 0) {
    throw new Error(`${totalDropped} row(s) were removed by the bill-level "Flag Status ID" filter — those could be open issues on bills the list calls resolved. Refusing to plan from an enumeration that may be missing flags.`);
  }
  return { issueIds, billIds: [...billIds], declared };
}

async function measure() {
  const dbc = getDatabase(KEY);
  const roster = await requireRoster(dbc);
  const encIds = new Set(roster.list.map((u) => u.userId));
  console.log(`ENC roster: ${roster.list.length} staff accounts in this database`);
  console.log(`Enumerating open flag issues (${PASSES} passes, unioned)…`);
  const { issueIds, billIds, declared } = await enumerateBills(dbc);
  console.log(`Reading ${billIds.length} bills live for per-issue proof…`);

  const plan = [];
  const setAside = { noFlaggedEvent: [], noAssignee: [], customerAssigned: [] };
  const counts = { openIssuesRead: 0, preCutoffOpen: 0, unreadableBills: 0 };
  await pool(billIds, 6, async (billId) => {
    let issues;
    try { issues = await getFlagIssuesForBillStrict(dbc, billId); }
    catch { counts.unreadableBills++; return; } // honest: never silently dropped
    for (const t of issues || []) {
      if (t?.flagIssueStatus?.flagIssueStatusId !== 1) continue;
      counts.openIssuesRead++;
      const c = classify(t, encIds);
      const base = { billId, flagIssueId: t.flagIssueId, type: t.flagIssueType?.flagIssueTypeInfo,
        created: c.created || null, assignees: (t.assignees || []).map((a) => a.fullName) };
      if (c.reason === 'no-flagged-event') { setAside.noFlaggedEvent.push(base); continue; }
      if (!isPreCutoff(c.created)) continue;
      counts.preCutoffOpen++;
      if (c.qualifies) plan.push({ ...base, assigneeIds: c.assigneeIds });
      else if (c.reason === 'no-assignee') setAside.noAssignee.push(base);
      else if (c.reason === 'has-customer-assignee') setAside.customerAssigned.push(base);
    }
  });
  return { key: KEY, customer: dbc.customer, cutoff: CUTOFF, declaredOpen: declared,
    unionOpenIssues: issueIds.size, billsRead: billIds.length, ...counts, plan, setAside };
}

// ── execution ───────────────────────────────────────────────────────────────────────────────────

async function execute(plan) {
  const dbc = getDatabase(KEY);
  const roster = await requireRoster(dbc);
  const encIds = new Set(roster.list.map((u) => u.userId));
  const byBill = new Map();
  for (const r of plan) { if (!byBill.has(r.billId)) byBill.set(r.billId, []); byBill.get(r.billId).push(r.flagIssueId); }
  const bills = [...byBill.entries()].map(([billId, flagIds]) => ({ billId, flagIds }));
  const res = { resolved: 0, skipped: { notOpen: 0, assigneeDrift: 0, missing: 0, dateDrift: 0, undatable: 0 }, failures: [] };
  let aborted = false;

  const doBill = async ({ billId, flagIds }) => {
    if (aborted) return;
    let issues;
    try { issues = await getFlagIssuesForBillStrict(dbc, billId); }
    catch (e) { res.failures.push({ billId, why: 'strict read: ' + e.message }); aborted = true; return; }
    const writes = [];
    for (const fid of flagIds) {
      const t = (issues || []).find((i) => i.flagIssueId === fid);
      if (!t) { res.skipped.missing++; continue; }
      // Full re-gate against the SAME classifier used at planning time — open, pre-cutoff by its own
      // event history, ENC-only assignees — evaluated on data read seconds ago, never on the plan.
      const c = classify(t, encIds);
      if (c.qualifies) { writes.push({ flagIssueId: fid, flagIssueStatusId: 2, assignees: (t.assignees || []).map((a) => a.userId), comment: COMMENT }); continue; }
      if (c.reason === 'not-open') res.skipped.notOpen++;
      else if (c.reason === 'no-flagged-event') res.skipped.undatable++;
      else if (c.reason === 'on-or-after-cutoff') res.skipped.dateDrift++;
      else res.skipped.assigneeDrift++;
    }
    if (!writes.length) return;
    const put = await ecapFetch(dbc, 'PUT', `/api/v202501/flag/flagIssue/bill/${billId}`, writes);
    if (put.status >= 300) { res.failures.push({ billId, why: `PUT http ${put.status}` }); aborted = true; return; }
    let after;
    try { after = await getFlagIssuesForBillStrict(dbc, billId); }
    catch (e) { res.failures.push({ billId, why: 'verify read: ' + e.message }); aborted = true; return; }
    for (const w of writes) {
      const t2 = (after || []).find((i) => i.flagIssueId === w.flagIssueId);
      const ok = t2?.flagIssueStatus?.flagIssueStatusId === 2 &&
        w.assignees.every((id) => (t2.assignees || []).map((a) => a.userId).includes(id));
      if (!ok) { res.failures.push({ billId, flagIssueId: w.flagIssueId, why: 'verify failed' }); aborted = true; return; }
    }
    res.resolved += writes.length;
  };

  // canary 25 issues → stop on ANY failure → then chunks of 250
  const canary = []; let n = 0;
  for (const b of bills) { canary.push(b); n += b.flagIds.length; if (n >= 25) break; }
  console.log(`  canary: ${canary.length} bills / ${n} issues…`);
  await pool(canary, 4, doBill);
  if (aborted || res.failures.length) return { ...res, abortedAt: 'canary' };
  console.log(`  canary OK (${res.resolved} resolved) — continuing in chunks of 250`);
  let chunk = [], cf = 0;
  const flush = async () => { if (!chunk.length || aborted) return; await pool(chunk, 6, doBill); chunk = []; cf = 0; };
  for (const b of bills.slice(canary.length)) { chunk.push(b); cf += b.flagIds.length; if (cf >= 250) { await flush(); if (aborted) break; } }
  await flush();

  if (!aborted) { // independent post-run sample: re-read 10 spread bills
    const all = bills.map((b) => b.billId);
    const step = Math.max(1, Math.floor(all.length / 10));
    const sample = all.filter((_, i) => i % step === 0).slice(0, 10);
    let still = 0, unverified = 0;
    await pool(sample, 5, async (billId) => {
      try {
        const issues = await getFlagIssuesForBillStrict(dbc, billId);
        for (const fid of byBill.get(billId)) {
          const t = (issues || []).find((i) => i.flagIssueId === fid);
          if (t && t.flagIssueStatus?.flagIssueStatusId === 1) still++;
        }
      } catch { unverified++; } // a failed read is NOT a pass
    });
    res.sampleBills = sample.length; res.sampleStillOpen = still; res.sampleUnverified = unverified;
  }
  return res;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

const m = await measure();
writeFileSync(join(RUN_DIR, 'plan.json'), JSON.stringify(m, null, 1));

console.log(`\n══ ${m.customer} · flags created before ${CUTOFF} ══`);
console.log(`  open flag issues in the database:     ${m.unionOpenIssues} (across ${m.billsRead} bills${m.unreadableBills ? `, ${m.unreadableBills} UNREADABLE` : ''})`);
console.log(`  open + created before cutoff:         ${m.preCutoffOpen}`);
console.log(`    ├─ ENC-assigned only → WILL RESOLVE ${m.plan.length}`);
console.log(`    ├─ has a customer assignee → leave  ${m.setAside.customerAssigned.length}`);
console.log(`    └─ no assignee at all → leave       ${m.setAside.noAssignee.length}`);
if (m.setAside.noFlaggedEvent.length) console.log(`  ⚠ undatable (no Flagged event) → left alone: ${m.setAside.noFlaggedEvent.length}`);
if (m.plan.length) {
  const dates = m.plan.map((r) => r.created.slice(0, 10)).sort();
  const types = {}; for (const r of m.plan) types[r.type] = (types[r.type] || 0) + 1;
  console.log(`  date range of the ${m.plan.length}: ${dates[0]} … ${dates[dates.length - 1]}  (newest must be < ${CUTOFF})`);
  console.log(`  bills affected: ${new Set(m.plan.map((r) => r.billId)).size}`);
  console.log(`  by flag type:`);
  for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) console.log(`     ${String(c).padStart(5)}  ${t}`);
}

if (LIVE && m.plan.length) {
  console.log(`\nExecuting…`);
  const r = await execute(m.plan);
  writeFileSync(join(RUN_DIR, 'results.json'), JSON.stringify(r, null, 1));
  const sk = Object.values(r.skipped).reduce((a, b) => a + b, 0);
  if (r.failures.length) console.error(`  ✖ STOPPED after ${r.resolved} resolved — ${JSON.stringify(r.failures.slice(0, 3))}`);
  else console.log(`  ✓ resolved ${r.resolved} · skipped ${sk} (drifted since planning) · post-run sample: ${r.sampleStillOpen} still open of ${r.sampleBills} bills re-read${r.sampleUnverified ? ` (⚠ ${r.sampleUnverified} unverified)` : ''}`);
}
console.log(`\nFull detail: ${RUN_DIR}`);
if (!LIVE) console.log('DRY RUN — nothing was changed. Re-run with --live to execute.');
