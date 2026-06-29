// Persistent store for the Path Heat accumulator: one row per aircraft (hex)
// holding its decimated flown leg, so the wide-area heatmap survives restarts
// and builds over the full window (default 24h, matching tar1090).
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/pathheat.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS path_legs (
    hex        TEXT PRIMARY KEY,
    points     TEXT    NOT NULL,   -- JSON [[lat,lon],…]
    last_seen  INTEGER NOT NULL,   -- last time the aircraft was overhead
    fetched_at INTEGER NOT NULL    -- last time the leg was fetched
  );
  CREATE INDEX IF NOT EXISTS idx_path_last_seen ON path_legs(last_seen);
`);

const _upsert = db.prepare(`
  INSERT INTO path_legs (hex, points, last_seen, fetched_at)
  VALUES (@hex, @points, @last_seen, @fetched_at)
  ON CONFLICT(hex) DO UPDATE SET
    points = excluded.points, last_seen = excluded.last_seen, fetched_at = excluded.fetched_at
`);
function upsertLeg(hex, points, ts) {
  _upsert.run({ hex, points: JSON.stringify(points), last_seen: ts, fetched_at: ts });
}

const _touch = db.prepare('UPDATE path_legs SET last_seen = ? WHERE hex = ?');
function touchLeg(hex, ts) { _touch.run(ts, hex); }

// Returns { hex, fetched_at } for a leg, or null — used to decide whether to refetch.
const _meta = db.prepare('SELECT hex, fetched_at FROM path_legs WHERE hex = ?');
function getLegMeta(hex) { return _meta.get(hex) || null; }

const _prune = db.prepare('DELETE FROM path_legs WHERE last_seen < ?');
function pruneLegs(beforeTs) { _prune.run(beforeTs); }

const _count = db.prepare('SELECT COUNT(*) AS n FROM path_legs WHERE last_seen >= ?');
function legCount(sinceTs) { return _count.get(sinceTs).n; }

// All points from legs still inside the window, as a flat [[lat,lon],…]
// (skips the null gap-markers — the heat layer only wants positions).
const _all = db.prepare('SELECT points FROM path_legs WHERE last_seen >= ? ORDER BY last_seen DESC');
function allPoints(sinceTs) {
  const out = [];
  for (const row of _all.all(sinceTs)) {
    try { for (const p of JSON.parse(row.points)) if (p) out.push(p); } catch { /* skip */ }
  }
  return out;
}

// Per-aircraft legs (newest first), each a point array that may contain null
// gap-markers — for the lines map, which breaks the polyline at the nulls.
function allLegs(sinceTs, limit = 150) {
  const out = [];
  for (const row of _all.all(sinceTs)) {
    try { const pts = JSON.parse(row.points); if (pts.length) out.push(pts); } catch { /* skip */ }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { upsertLeg, touchLeg, getLegMeta, pruneLegs, legCount, allPoints, allLegs };
