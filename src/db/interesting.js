const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/interesting.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS interesting_aircraft (
    icao         TEXT PRIMARY KEY,
    registration TEXT,
    operator     TEXT,
    type         TEXT,
    icao_type    TEXT,
    category     TEXT,   -- one of: military | government | police | civilian | other
    group_code   TEXT,   -- raw #CMPG value (Mil/Gov/Pol/Civ/...)
    tag1         TEXT,
    tag2         TEXT,
    tag3         TEXT,
    link         TEXT,
    image_link   TEXT
  );

  CREATE TABLE IF NOT EXISTS interesting_seen (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    icao      TEXT NOT NULL,
    flight    TEXT,
    seen_at   INTEGER NOT NULL,
    lat       REAL,
    lon       REAL,
    alt       INTEGER,
    squawk    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_seen_icao_time ON interesting_seen(icao, seen_at);
  CREATE INDEX IF NOT EXISTS idx_seen_time      ON interesting_seen(seen_at);

  CREATE TABLE IF NOT EXISTS interesting_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const _upsert = db.prepare(`
  INSERT INTO interesting_aircraft
    (icao, registration, operator, type, icao_type, category, group_code, tag1, tag2, tag3, link, image_link)
  VALUES
    (@icao, @registration, @operator, @type, @icao_type, @category, @group_code, @tag1, @tag2, @tag3, @link, @image_link)
  ON CONFLICT(icao) DO UPDATE SET
    registration = excluded.registration, operator = excluded.operator,
    type = excluded.type, icao_type = excluded.icao_type,
    category = excluded.category, group_code = excluded.group_code,
    tag1 = excluded.tag1, tag2 = excluded.tag2, tag3 = excluded.tag3,
    link = excluded.link, image_link = excluded.image_link
`);

const upsertManyInteresting = db.transaction((rows) => {
  for (const r of rows) _upsert.run(r);
});

function interestingCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM interesting_aircraft').get().n;
}

function getInteresting(hex) {
  return db.prepare('SELECT * FROM interesting_aircraft WHERE icao = ?').get((hex || '').toLowerCase()) || null;
}

// Record a sighting, de-duped: skip if the same icao was logged within `dedupeMs`.
function recordSighting({ icao, flight, lat, lon, alt, squawk }, dedupeMs = 3600_000) {
  const hex = (icao || '').toLowerCase();
  const recent = db.prepare('SELECT seen_at FROM interesting_seen WHERE icao = ? ORDER BY seen_at DESC LIMIT 1').get(hex);
  const now = Date.now();
  if (recent && now - recent.seen_at < dedupeMs) return false;
  db.prepare(`
    INSERT INTO interesting_seen (icao, flight, seen_at, lat, lon, alt, squawk)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hex, flight || null, now, lat ?? null, lon ?? null, alt ?? null, squawk || null);
  return true;
}

// Recent sightings joined with metadata, newest first.
function getRecentSightings(limit = 50) {
  return db.prepare(`
    SELECT s.icao, s.flight, s.seen_at, s.lat, s.lon, s.alt, s.squawk,
           a.registration, a.operator, a.type, a.category, a.group_code,
           a.tag1, a.tag2, a.tag3, a.link, a.image_link
    FROM interesting_seen s
    JOIN interesting_aircraft a ON a.icao = s.icao
    ORDER BY s.seen_at DESC
    LIMIT ?
  `).all(Math.min(limit, 500));
}

// Watchlist sightings leaderboard (top 12 planes, operators, and types)
function getWatchlistLeaderboard() {
  const aircraft = db.prepare(`
    SELECT s.icao, a.registration, a.operator, a.type, COUNT(*) as count
    FROM interesting_seen s
    JOIN interesting_aircraft a ON a.icao = s.icao
    GROUP BY s.icao
    ORDER BY count DESC
    LIMIT 12
  `).all();

  const operators = db.prepare(`
    SELECT a.operator, COUNT(*) as count
    FROM interesting_seen s
    JOIN interesting_aircraft a ON a.icao = s.icao
    WHERE a.operator IS NOT NULL AND a.operator != ''
    GROUP BY a.operator
    ORDER BY count DESC
    LIMIT 12
  `).all();

  const types = db.prepare(`
    SELECT a.type, COUNT(*) as count
    FROM interesting_seen s
    JOIN interesting_aircraft a ON a.icao = s.icao
    WHERE a.type IS NOT NULL AND a.type != ''
    GROUP BY a.type
    ORDER BY count DESC
    LIMIT 12
  `).all();

  return { aircraft, operators, types };
}

function getMeta(key) {
  return db.prepare('SELECT value FROM interesting_meta WHERE key = ?').get(key)?.value || null;
}
function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO interesting_meta (key, value) VALUES (?, ?)').run(key, String(value));
}

function pruneSightings(days = 90) {
  db.prepare('DELETE FROM interesting_seen WHERE seen_at < ?').run(Date.now() - days * 86400000);
}

// ── Watchlist Management ──────────────────────────────────────────
function getWatchlist(page = 1, limit = 20, search = '') {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM interesting_aircraft';
  let countQuery = 'SELECT COUNT(*) AS total FROM interesting_aircraft';
  const params = [];
  
  if (search) {
    const cleanSearch = `%${search.toLowerCase()}%`;
    const filter = ' WHERE LOWER(icao) LIKE ? OR LOWER(registration) LIKE ? OR LOWER(operator) LIKE ? OR LOWER(type) LIKE ?';
    query += filter;
    countQuery += filter;
    params.push(cleanSearch, cleanSearch, cleanSearch, cleanSearch);
  }
  
  query += ' ORDER BY icao ASC LIMIT ? OFFSET ?';
  
  const total = db.prepare(countQuery).get(...params).total;
  const items = db.prepare(query).all(...params, limit, offset);
  
  return { items, total, page, limit };
}

function deleteWatchlist(icao) {
  return db.prepare('DELETE FROM interesting_aircraft WHERE icao = ?').run((icao || '').toLowerCase()).changes > 0;
}

function upsertWatchlist(ac) {
  const row = {
    icao: (ac.icao || '').toLowerCase(),
    registration: ac.registration || null,
    operator: ac.operator || null,
    type: ac.type || null,
    icao_type: ac.icao_type || null,
    category: ac.category || 'other',
    group_code: ac.group_code || null,
    tag1: ac.tag1 || null,
    tag2: ac.tag2 || null,
    tag3: ac.tag3 || null,
    link: ac.link || null,
    image_link: ac.image_link || null
  };
  _upsert.run(row);
  return true;
}

module.exports = {
  upsertManyInteresting, interestingCount, getInteresting,
  recordSighting, getRecentSightings, getWatchlistLeaderboard, getMeta, setMeta, pruneSightings,
  getWatchlist, deleteWatchlist, upsertWatchlist
};
