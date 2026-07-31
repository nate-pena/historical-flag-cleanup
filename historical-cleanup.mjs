/**
 * historical-flag-cleanup — standalone tool (NOT part of the Flag Ops portal).
 * ────────────────────────────────────────────────────────────────────────────
 * Closes EnergyCAP audit flags that sit on HISTORICAL bills and are assigned only to ENC staff.
 *
 * THE RULE (policy — ENC is not responsible for flags on historical bills):
 *   A bill is HISTORICAL when its vendor statement date is 61+ calendar days before the date the
 *   bill was uploaded into EnergyCAP (createdDate). If the bill has no statement date, the service
 *   period end date is used instead. A flag qualifies ONLY if it is OPEN live AND every live
 *   assignee is EnergyCAP staff (@energycap.com, matched by userId against the live per-DB roster).
 *   Flags with any customer assignee are NEVER touched; empty-assignee flags are set aside.
 *
 * USAGE
 *   node historical-cleanup.mjs --customers=all              # DRY RUN, every customer (thorough)
 *   node historical-cleanup.mjs --customers=pge-ca,sonoco    # DRY RUN, named customers
 *   node historical-cleanup.mjs --customers=sonoco --live    # execute (canary → chunks → verify)
 *   Flags: --fast            quick LOWER-BOUND estimate (roster-name prefilter); BLOCKED from --live
 *          --include-special include special-handling customers (EXCLUDED by default)
 *          --days=N          override the 61-day threshold (whole number ≥ 14; default 61)
 *   Runs are THOROUGH by default (every open bill live-checked = exact count); --fast opts down to a
 *   quick estimate and can never drive a --live run.
 *
 * SAFETY (all non-negotiable):
 *   dry-run by default · special-handling customers excluded by default · live re-verification of
 *   every flag (still open + still ENC-only) the moment before writing · assignees preserved ·
 *   canary 25 flags then chunks of 250 · verify-after-write on every flag · abort-on-anomaly ·
 *   automatic post-run verification sample · full plan + results JSON written to ./runs/.
 *
 * DEPENDENCY: reads config/credentials and the API client from the local flag-ops checkout
 * (FLAG_OPS_DIR, default ~/code/flag-ops) so API keys stay in exactly one audited place (.env
 * there). This tool NEVER prints a key, and never reads .env itself — the flag-ops modules do.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FLAG_OPS = process.env.FLAG_OPS_DIR || join(homedir(), 'code', 'flag-ops');
const { getDatabase, listDatabaseKeys } = await import(join(FLAG_OPS, 'config.mjs'));
const { fetchUnresolvedFlagRows, getBill, getFlagIssuesForBillStrict, ecapFetch, pool } = await import(join(FLAG_OPS, 'ecap.mjs'));
const { getEncRoster } = await import(join(FLAG_OPS, 'encdir.mjs'));
const { SPECIAL_HANDLING_DBS } = await import(join(FLAG_OPS, 'specialhandling.mjs'));

// Argument parsing is deliberately STRICT: an unrecognized or malformed argument aborts the run.
// (A silently-ignored typo could otherwise expand a run's scope to ALL customers unintentionally.)
// THOROUGH is the DEFAULT: a real run must check every open bill live so the count
// is exact and never quietly under-reports. --fast is an explicit opt-in for a quick LOWER-BOUND
// estimate (checks only bills the flag list already tags ENC-assigned). --thorough is accepted as a
// harmless no-op alias so it never errors under the strict parser.
const KNOWN_FLAGS = new Set(['--live', '--thorough', '--fast', '--include-special']);
const KNOWN_OPTS = new Set(['customers', 'days']);
const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (KNOWN_FLAGS.has(a)) continue;
  const mEq = a.match(/^--([a-z-]+)=(.*)$/);
  if (mEq && KNOWN_OPTS.has(mEq[1])) { opts[mEq[1]] = mEq[2]; continue; }
  const mSp = a.match(/^--([a-z-]+)$/);
  if (mSp && KNOWN_OPTS.has(mSp[1]) && argv[i + 1] && !argv[i + 1].startsWith('--')) { opts[mSp[1]] = argv[++i]; continue; }
  console.error(`Unrecognized argument: "${a}". Valid: --customers=<keys|all> --live --thorough --include-special --days=N`);
  process.exit(1);
}
const arg = (name, dflt) => (opts[name] !== undefined ? opts[name] : dflt);
const LIVE = process.argv.includes('--live');
const FAST = process.argv.includes('--fast');           // opt-in quick lower-bound estimate
const THOROUGH = !FAST;                                  // default: exhaustive live census
const INCLUDE_SPECIAL = process.argv.includes('--include-special');
if (LIVE && opts.customers === undefined) {
  console.error('--live requires an EXPLICIT --customers=<keys|all> (never an implied default).');
  process.exit(1);
}
if (LIVE && FAST) {
  console.error('--fast is a lower-bound ESTIMATE and must never drive a --live run (it can miss ENC-assigned flags). Re-run --live without --fast.');
  process.exit(1);
}
// --days: range-check the VALUE, never clamp. A negative/fractional/tiny value would silently
// collapse the safety window and reclassify current bills as historical, so we abort instead.
const DAYS_FLOOR = 14; // no legitimate "historical" policy is shorter than two weeks
let DAYS = 61;
if (opts.days !== undefined) {
  const n = Number(opts.days);
  if (!Number.isInteger(n) || n < DAYS_FLOOR || n > 3650) {
    console.error(`--days must be a whole number between ${DAYS_FLOOR} and 3650 (got "${opts.days}"). The default is 61; only change it for a deliberate policy change.`);
    process.exit(1);
  }
  DAYS = n;
}
const COMMENT = `Historical bill — out of scope for ENC (${DAYS}+ days old at upload)`;
// Run dir carries a full millisecond timestamp PLUS the process id so two runs launched in the same
// second can never overwrite each other's plan/results — the audit trail is strictly append-only.
// import.meta.dirname is the tool's own folder.
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const RUN_DIR = join(import.meta.dirname, 'runs', stamp);
mkdirSync(RUN_DIR, { recursive: true });

const want = arg('customers', 'all');
let keys = want === 'all' ? listDatabaseKeys() : want.split(',').map((s) => s.trim()).filter(Boolean);
// Non-throwing key validation: getDatabase() THROWS on an unknown key, so validate against the
// roster list instead (a bad key must print the friendly message, not a raw stack trace).
const validKeys = new Set(listDatabaseKeys());
const unknown = keys.filter((k) => !validKeys.has(k));
if (unknown.length) { console.error(`Unknown customer key(s): ${unknown.join(', ')}. Valid keys come from the flag-ops roster (run with --customers=all to process every customer).`); process.exit(1); }
const skippedSpecial = keys.filter((k) => SPECIAL_HANDLING_DBS.includes(k) && !INCLUDE_SPECIAL);
keys = keys.filter((k) => !skippedSpecial.includes(k));
if (skippedSpecial.length) console.log(`⚠ Skipping special-handling customers (their contracts differ from the standard playbook): ${skippedSpecial.join(', ')} — rerun with --include-special AFTER confirming the historical policy applies to them.`);
if (!keys.length) { console.error('No customers left to process.'); process.exit(1); }
console.log(`Mode: ${LIVE ? 'LIVE (will write)' : 'DRY RUN (no writes)'} · rule: ${DAYS}+ days · customers: ${keys.length}\n`);

const days = (a, b) => Math.floor((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 86400000);

/**
 * Decide if a bill is historical, hardened against bad vendor dates.
 * A real invoice's statement date is on/after its service-period end. If statementDate is BEFORE
 * endDate it is implausible (year typos etc.), so we DISTRUST it and age the bill by its service-end
 * date instead — which is the conservative choice (it can only make a bill look younger, never
 * older, so a current bill can't be tipped into "historical" by a bad statement date).
 * Returns { historical, daysLate, via } or { historical:false } when undecidable.
 */
/**
 * Read a bill with retries and REQUIRE a well-formed result (getBill is lenient —
 * on a transient server error it returns an error body instead of throwing, which would let a real
 * bill silently vanish from the "exact" count, or a real flag get mislabeled "not historical" at
 * write time). A genuine bill always carries a createdDate and a positive billId; anything else is a
 * read failure and is thrown, so callers handle it honestly (measure → counts it as unreadable;
 * execute → aborts) and never guess.
 */
async function readBillStrict(dbc, billId) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const b = await getBill(dbc, billId);
      if (b && b.createdDate && Number(b.billId) > 0) return b;
      last = new Error(`malformed bill ${billId}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  throw last || new Error(`bill ${billId} unreadable`);
}

function classifyHistorical(bill) {
  const created = bill?.createdDate, stmt = bill?.statementDate, end = bill?.endDate;
  if (!created) return { historical: false, via: 'no-created-date' };
  const stmtPlausible = stmt && (!end || String(stmt).slice(0, 10) >= String(end).slice(0, 10));
  if (stmtPlausible) { const d = days(created, stmt); return { historical: d >= DAYS, daysLate: d, via: 'statement' }; }
  if (end) { const d = days(created, end); return { historical: d >= DAYS, daysLate: d, via: 'service-end', distrustedStatement: !!stmt }; }
  return { historical: false, via: 'no-usable-date' };
}

/** The staff roster is the safety backbone: without it we cannot PROVE an assignee is ENC, so a
 *  missing roster means the customer is SKIPPED entirely (fail safe), never guessed. One retry. */
async function requireRoster(dbc) {
  const roster = (await getEncRoster(dbc)) || (await getEncRoster(dbc, { force: true }));
  if (!roster || !roster.list || !roster.list.length) throw new Error('ENC roster unavailable — customer skipped (cannot verify assignees safely)');
  return roster;
}

async function measure(key) {
  const dbc = getDatabase(key);
  const roster = await requireRoster(dbc);
  const encIds = new Set(roster.list.map((u) => u.userId));
  const encNames = roster.list.map((u) => String(u.fullName || '').toLowerCase()).filter(Boolean);
  const { rows } = await fetchUnresolvedFlagRows(dbc, { pageSize: 250 });
  let billIds = [...new Set(rows.map((r) => r['Bill ID']).filter(Boolean))];
  // Discovery prefilter (skippable with --thorough): only bills whose list row mentions an ENC
  // roster name. The list's assignee column is bill-level and can be stale, but observed staleness
  // over-includes (safe: a wasted read). --thorough removes even that assumption.
  if (!THOROUGH) {
    const encBills = new Set(rows.filter((r) => { const a = String(r['Flag Issue Assignee'] || '').toLowerCase(); return encNames.some((n) => a.includes(n)); }).map((r) => r['Bill ID']));
    billIds = billIds.filter((b) => encBills.has(b));
  }
  const plan = []; let fetchFail = 0;
  await pool(billIds, 6, async (billId) => {
    let bill, issues;
    try { [bill, issues] = await Promise.all([readBillStrict(dbc, billId), getFlagIssuesForBillStrict(dbc, billId)]); }
    catch { fetchFail++; return; } // honest: an unreadable bill is counted, never silently dropped
    if (bill.void) return;
    const cls = classifyHistorical(bill);
    if (!cls.historical) return;
    for (const t of issues || []) {
      if (t.flagIssueStatus?.flagIssueStatusId !== 1) continue;
      const as = t.assignees || [];
      if (!as.length) continue;                       // empty-assignee → human decision, never auto
      if (!as.every((a) => encIds.has(a.userId))) continue; // any customer assignee → untouchable
      plan.push({ billId, flagIssueId: t.flagIssueId, type: t.flagIssueType?.flagIssueTypeInfo,
        statementDate: bill.statementDate || null, endDate: bill.endDate || null, createdDate: bill.createdDate,
        daysLate: cls.daysLate, via: cls.via, distrustedStatement: !!cls.distrustedStatement,
        assigneeIds: as.map((a) => a.userId) });
    }
  });
  return { key, customer: dbc.customer, billsChecked: billIds.length, fetchFail, plan };
}

async function execute(key, plan) {
  const dbc = getDatabase(key);
  const roster = await requireRoster(dbc);
  const encIds = new Set(roster.list.map((u) => u.userId));
  const byBill = new Map();
  for (const r of plan) { if (!byBill.has(r.billId)) byBill.set(r.billId, []); byBill.get(r.billId).push(r.flagIssueId); }
  const bills = [...byBill.entries()].map(([billId, flagIds]) => ({ billId, flagIds }));
  const res = { resolved: 0, skippedNotOpen: 0, skippedAssigneeDrift: 0, skippedMissing: 0, failures: [] };
  let aborted = false;
  const doBill = async ({ billId, flagIds }) => {
    if (aborted) return;
    let issues, bill;
    try { [issues, bill] = await Promise.all([getFlagIssuesForBillStrict(dbc, billId), readBillStrict(dbc, billId)]); }
    catch (e) { res.failures.push({ billId, why: 'strict read: ' + e.message }); aborted = true; return; }
    // Write-time date re-gate: re-confirm the bill is STILL historical under the
    // hardened rule at the moment of writing — never trust the planning-time classification alone.
    // bill is guaranteed well-formed here (readBillStrict), so a skip means genuinely void or
    // not-historical, never a hidden read failure.
    if (bill.void) { res.skippedVoided = (res.skippedVoided || 0) + flagIds.length; return; }
    if (!classifyHistorical(bill).historical) { res.skippedNotHistorical = (res.skippedNotHistorical || 0) + flagIds.length; return; }
    const writes = [];
    for (const fid of flagIds) {
      const t = (issues || []).find((i) => i.flagIssueId === fid);
      if (!t) { res.skippedMissing++; continue; }
      if (t.flagIssueStatus?.flagIssueStatusId !== 1) { res.skippedNotOpen++; continue; }
      const as = t.assignees || [];
      if (!as.length || !as.every((a) => encIds.has(a.userId))) { res.skippedAssigneeDrift++; continue; }
      writes.push({ flagIssueId: fid, flagIssueStatusId: 2, assignees: as.map((a) => a.userId), comment: COMMENT });
    }
    if (!writes.length) return;
    const put = await ecapFetch(dbc, 'PUT', `/api/v202501/flag/flagIssue/bill/${billId}`, writes);
    if (put.status >= 300) { res.failures.push({ billId, why: `PUT http ${put.status}` }); aborted = true; return; }
    let after;
    try { after = await getFlagIssuesForBillStrict(dbc, billId); }
    catch (e) { res.failures.push({ billId, why: 'verify read: ' + e.message }); aborted = true; return; }
    for (const w of writes) {
      const t2 = (after || []).find((i) => i.flagIssueId === w.flagIssueId);
      const ok = t2?.flagIssueStatus?.flagIssueStatusId === 2 && w.assignees.every((id) => (t2.assignees || []).map((a) => a.userId).includes(id));
      if (!ok) { res.failures.push({ billId, flagIssueId: w.flagIssueId, why: 'verify failed' }); aborted = true; return; }
    }
    res.resolved += writes.length;
  };
  let canary = []; let n = 0;
  for (const b of bills) { canary.push(b); n += b.flagIds.length; if (n >= 25) break; }
  await pool(canary, 4, doBill);
  if (aborted || res.failures.length) return { ...res, abortedAt: 'canary' };
  let chunk = []; let cf = 0;
  const flush = async () => { if (!chunk.length || aborted) return; await pool(chunk, 6, doBill); chunk = []; cf = 0; };
  for (const b of bills.slice(canary.length)) { chunk.push(b); cf += b.flagIds.length; if (cf >= 250) { await flush(); if (aborted) break; } }
  await flush();
  if (!aborted) { // post-run verification sample: 10 spread bills re-read independently
    const all = bills.map((b) => b.billId); const step = Math.max(1, Math.floor(all.length / 10));
    const sample = all.filter((_, i) => i % step === 0).slice(0, 10);
    let still = 0, unverified = 0;
    await pool(sample, 5, async (billId) => {
      try { const issues = await getFlagIssuesForBillStrict(dbc, billId);
        for (const fid of byBill.get(billId)) { const t = (issues || []).find((i) => i.flagIssueId === fid); if (t && t.flagIssueStatus?.flagIssueStatusId === 1) still++; } }
      catch { unverified++; } // a failed read is NOT a pass — count it honestly, never floor to 0
    });
    res.sampleStillOpen = still;          // integer count of flags found still-open in the sample (want 0)
    res.sampleUnverified = unverified;    // bills whose re-read failed — the sample did NOT clear them
  }
  return res;
}

const summary = [];
for (const key of keys) {
  let m;
  try { m = await measure(key); }
  catch (e) { console.error(`✖ ${key}: ${e.message}`); summary.push({ customer: key, key, candidates: 0, error: e.message }); continue; }
  const viaEnd = m.plan.filter((r) => r.via === 'service-end').length;
  const distrusted = m.plan.filter((r) => r.distrustedStatement).length;
  console.log(`${m.customer || key}: checked ${m.billsChecked} bills${m.fetchFail ? ` (${m.fetchFail} unreadable)` : ''} → ${m.plan.length} historical ENC-only flags${viaEnd ? ` (${viaEnd} dated by service-end${distrusted ? `, incl. ${distrusted} with an implausible statement date` : ' — no statement date'})` : ''}`);
  console.log(FAST
    ? `   (⚠ FAST mode: counted only bills the flag list tags ENC-assigned — a LOWER BOUND, not a census. Drop --fast for the exact count.)`
    : `   (thorough: live-checked every open bill — this is the exact count)`);
  writeFileSync(join(RUN_DIR, `plan-${key}.json`), JSON.stringify(m, null, 1));
  const row = { customer: m.customer || key, key, candidates: m.plan.length };
  if (LIVE && m.plan.length) {
    const r = await execute(key, m.plan);
    writeFileSync(join(RUN_DIR, `results-${key}.json`), JSON.stringify(r, null, 1));
    Object.assign(row, { resolved: r.resolved, skipped: r.skippedNotOpen + r.skippedAssigneeDrift + r.skippedMissing + (r.skippedNotHistorical || 0) + (r.skippedVoided || 0), failures: r.failures.length, sampleStillOpen: r.sampleStillOpen ?? null, sampleUnverified: r.sampleUnverified ?? null });
    if (r.failures.length) { console.error(`  ✖ ${key}: STOPPED after ${r.resolved} resolved — ${JSON.stringify(r.failures.slice(0, 3))}`); summary.push(row); break; }
    const warn = (r.sampleStillOpen > 0) ? ' ⚠ SAMPLE FOUND OPEN FLAGS — INVESTIGATE' : (r.sampleUnverified > 0 ? ` (⚠ ${r.sampleUnverified} sample bills unverified — reads failed)` : '');
    console.log(`  ✓ resolved ${r.resolved} · skipped ${row.skipped} (drifted/no-longer-historical) · post-sample still-open ${r.sampleStillOpen}${warn}`);
  }
  summary.push(row);
}
console.log(`\n══ SUMMARY (${LIVE ? 'LIVE' : 'DRY RUN'}) ══`);
for (const s of summary) console.log(`  ${s.customer}: ${s.error ? 'SKIPPED — ' + s.error : `${s.candidates} qualifying${LIVE ? ` → resolved ${s.resolved ?? 0}` : ''}`}`);
console.log(`  TOTAL qualifying: ${summary.reduce((a, s) => a + s.candidates, 0)}${LIVE ? ` · resolved: ${summary.reduce((a, s) => a + (s.resolved || 0), 0)}` : ''}`);
writeFileSync(join(RUN_DIR, 'summary.json'), JSON.stringify({ mode: LIVE ? 'live' : 'dry-run', days: DAYS, thorough: THOROUGH, at: stamp, summary }, null, 1));
console.log(`  Full detail: ${RUN_DIR}`);
if (!LIVE) console.log('  DRY RUN — no flags or bills were changed (a run does create & delete short-lived server-side query lists to page results). Re-run with --live to execute after reviewing the numbers.');
