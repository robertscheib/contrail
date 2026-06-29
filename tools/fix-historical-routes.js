#!/usr/bin/env node
// One-time correction of historical route pollution (pre geo-filter):
//  1. Re-aggregate days that still have raw snapshots (full clean recompute).
//  2. Filter top_routes_json in place for older days (snapshots pruned).
//  3. Delete the 3 route-based all-time records (farthest_origin/dest/longest_stage)
//     that were set from bad matches (e.g. NRT) — the live checker repopulates
//     them from now-filtered data within ~60s.
// Dry-run by default; pass --apply to write. Run from the radar-dash dir.
const path = require('path');
const Database = require('better-sqlite3');
const { routeNearHome } = require('../src/lib/geo');
const { aggregateDay } = require('../src/lib/stats-engine');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '../data/stats.db'));
db.pragma('busy_timeout = 8000');

const BAD_RECORDS = ['farthest_origin_km', 'farthest_dest_km', 'longest_stage_nm'];

const snapDates = new Set(db.prepare(
  `SELECT DISTINCT strftime('%Y-%m-%d', captured_at/1000, 'unixepoch') AS d FROM aircraft_snapshots`
).all().map(r => r.d));

const rows = db.prepare('SELECT date, top_routes_json FROM daily_stats WHERE top_routes_json IS NOT NULL ORDER BY date').all();

let reaggCount = 0, filterDays = 0, routesDropped = 0;
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} daily rows with route data\n`);

for (const r of rows) {
  if (snapDates.has(r.date)) {
    console.log(`  ${r.date}  re-aggregate from snapshots (clean recompute)`);
    if (APPLY) aggregateDay(r.date);
    reaggCount++;
    continue;
  }
  let routes = []; try { routes = JSON.parse(r.top_routes_json); } catch { continue; }
  const kept = routes.filter(x => routeNearHome(x.origin, x.destination));
  const dropped = routes.length - kept.length;
  if (dropped > 0) {
    console.log(`  ${r.date}  filter in place: drop ${dropped}/${routes.length}`);
    routesDropped += dropped; filterDays++;
    if (APPLY) db.prepare('UPDATE daily_stats SET top_routes_json = ? WHERE date = ?')
      .run(kept.length ? JSON.stringify(kept) : null, r.date);
  }
}

console.log('\n  Records to delete (will self-heal from live filtered data):');
for (const key of BAD_RECORDS) {
  const rec = db.prepare('SELECT value_text, callsign, detail FROM records WHERE record_key = ?').get(key);
  console.log(`    ${key}: ${rec ? `${rec.value_text} (${rec.callsign}) — ${rec.detail}` : '(absent)'}`);
  if (APPLY && rec) db.prepare('DELETE FROM records WHERE record_key = ?').run(key);
}

console.log(`\nSummary: re-aggregate ${reaggCount} day(s), filter ${filterDays} day(s) (${routesDropped} bad routes dropped), delete ${BAD_RECORDS.length} records.`);
console.log(APPLY ? 'APPLIED.\n' : 'No changes written. Re-run with --apply to commit.\n');
