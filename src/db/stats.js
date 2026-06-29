const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/stats.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at    INTEGER NOT NULL,
    aircraft_count INTEGER NOT NULL,
    aircraft_json  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snap_time ON aircraft_snapshots(captured_at);

  CREATE TABLE IF NOT EXISTS daily_stats (
    date               TEXT PRIMARY KEY,
    max_aircraft       INTEGER,
    total_seen         INTEGER,
    peak_hour          INTEGER,
    commercial_count   INTEGER,
    ga_count           INTEGER,
    military_count     INTEGER,
    unknown_count      INTEGER,
    top_airline        TEXT,
    top_route          TEXT,
    longest_flight_nm  INTEGER,
    farthest_origin    TEXT,
    farthest_origin_km REAL,
    farthest_dest      TEXT,
    farthest_dest_km   REAL,
    avg_altitude       INTEGER,
    max_altitude       INTEGER,
    max_speed          INTEGER,
    source             TEXT DEFAULT 'live'
  );

  CREATE TABLE IF NOT EXISTS records (
    record_key    TEXT PRIMARY KEY,
    value_num     REAL,
    value_text    TEXT,
    callsign      TEXT,
    detail        TEXT,
    achieved_at   INTEGER,
    achieved_date TEXT
  );

  CREATE TABLE IF NOT EXISTS feeder_history (
    logged_at   INTEGER NOT NULL,
    feeder_key  TEXT NOT NULL,
    status      TEXT NOT NULL,
    msg_count   INTEGER,
    PRIMARY KEY (logged_at, feeder_key)
  );
  CREATE INDEX IF NOT EXISTS idx_feeder_history_time ON feeder_history(logged_at);
`);

// ── Migrations ──────────────────────────────────────────────────
const dailyCols = db.prepare('PRAGMA table_info(daily_stats)').all().map(c => c.name);
if (!dailyCols.includes('type_breakdown_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN type_breakdown_json TEXT');
if (!dailyCols.includes('top_routes_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN top_routes_json TEXT');
if (!dailyCols.includes('top_airlines_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN top_airlines_json TEXT');
if (!dailyCols.includes('top_countries_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN top_countries_json TEXT');
if (!dailyCols.includes('top_airports_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN top_airports_json TEXT');
if (!dailyCols.includes('day_records_json'))
  db.exec('ALTER TABLE daily_stats ADD COLUMN day_records_json TEXT');

function insertSnapshot(count, aircraftArray) {
  db.prepare(`
    INSERT INTO aircraft_snapshots (captured_at, aircraft_count, aircraft_json)
    VALUES (?, ?, ?)
  `).run(Date.now(), count, JSON.stringify(aircraftArray));
}

function getRecentSnapshots(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  return db.prepare('SELECT * FROM aircraft_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC').all(since);
}

function getSnapshotsByDate(dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
  const dayEnd   = dayStart + 86400000;
  return db.prepare('SELECT * FROM aircraft_snapshots WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC').all(dayStart, dayEnd);
}

function getTodaySnapshots() {
  const dayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return db.prepare('SELECT aircraft_json, captured_at FROM aircraft_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC').all(dayStart);
}

function getDayStats(date) {
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(date) || null;
}

const _upsertDaily = db.prepare(`
  INSERT INTO daily_stats (
    date, max_aircraft, total_seen, peak_hour,
    commercial_count, ga_count, military_count, unknown_count,
    top_airline, top_route, longest_flight_nm,
    farthest_origin, farthest_origin_km, farthest_dest, farthest_dest_km,
    avg_altitude, max_altitude, max_speed, source,
    type_breakdown_json, top_routes_json, top_airlines_json,
    top_countries_json, top_airports_json, day_records_json
  ) VALUES (
    @date, @max_aircraft, @total_seen, @peak_hour,
    @commercial_count, @ga_count, @military_count, @unknown_count,
    @top_airline, @top_route, @longest_flight_nm,
    @farthest_origin, @farthest_origin_km, @farthest_dest, @farthest_dest_km,
    @avg_altitude, @max_altitude, @max_speed, @source,
    @type_breakdown_json, @top_routes_json, @top_airlines_json,
    @top_countries_json, @top_airports_json, @day_records_json
  )
  ON CONFLICT(date) DO UPDATE SET
    max_aircraft        = excluded.max_aircraft,
    total_seen          = excluded.total_seen,
    peak_hour           = excluded.peak_hour,
    commercial_count    = excluded.commercial_count,
    ga_count            = excluded.ga_count,
    military_count      = excluded.military_count,
    unknown_count       = excluded.unknown_count,
    top_airline         = excluded.top_airline,
    top_route           = excluded.top_route,
    longest_flight_nm   = excluded.longest_flight_nm,
    farthest_origin     = excluded.farthest_origin,
    farthest_origin_km  = excluded.farthest_origin_km,
    farthest_dest       = excluded.farthest_dest,
    farthest_dest_km    = excluded.farthest_dest_km,
    avg_altitude        = excluded.avg_altitude,
    max_altitude        = excluded.max_altitude,
    max_speed           = excluded.max_speed,
    source              = excluded.source,
    type_breakdown_json = excluded.type_breakdown_json,
    top_routes_json     = excluded.top_routes_json,
    top_airlines_json   = excluded.top_airlines_json,
    top_countries_json  = excluded.top_countries_json,
    top_airports_json   = excluded.top_airports_json,
    day_records_json    = excluded.day_records_json
`);

// ── Feeder history logging ─────────────────────────────────────────
function logFeederStatus(feederKey, status, msgCount = null) {
  // Prune history older than 7 days to keep database compact
  const cutoff = Date.now() - 7 * 86400 * 1000;
  db.prepare('DELETE FROM feeder_history WHERE logged_at < ?').run(cutoff);

  db.prepare(`
    INSERT OR REPLACE INTO feeder_history (logged_at, feeder_key, status, msg_count)
    VALUES (?, ?, ?, ?)
  `).run(Date.now(), feederKey, status, msgCount);
}

function getFeederHistory(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  return db.prepare(`
    SELECT logged_at, feeder_key, status, msg_count
    FROM feeder_history
    WHERE logged_at >= ?
    ORDER BY logged_at ASC
  `).all(since);
}

function upsertDailyStats(date, statsObj) {
  _upsertDaily.run({
    type_breakdown_json: null,
    top_routes_json:     null,
    top_airlines_json:   null,
    top_countries_json:  null,
    top_airports_json:   null,
    day_records_json:    null,
    ...statsObj,
    date,
  });
}

function getDailyStats(days) {
  return db.prepare('SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?').all(Math.min(days, 3650));
}

function getMonthlyStats(months) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m', date)        AS month,
      MAX(max_aircraft)              AS max_aircraft,
      SUM(COALESCE(total_seen,0))    AS total_seen,
      SUM(COALESCE(commercial_count,0)) AS commercial_count,
      SUM(COALESCE(ga_count,0))      AS ga_count,
      SUM(COALESCE(military_count,0)) AS military_count,
      MAX(COALESCE(max_altitude,0))  AS max_altitude,
      MAX(COALESCE(max_speed,0))     AS max_speed,
      COUNT(*)                       AS days_tracked,
      MIN(source)                    AS source
    FROM daily_stats
    GROUP BY month
    ORDER BY month DESC
    LIMIT ?
  `).all(Math.min(months, 120));
}

function getYearlyStats() {
  return db.prepare(`
    SELECT
      strftime('%Y', date)           AS year,
      MAX(max_aircraft)              AS max_aircraft,
      SUM(COALESCE(total_seen,0))    AS total_seen,
      SUM(COALESCE(commercial_count,0)) AS commercial_count,
      SUM(COALESCE(ga_count,0))      AS ga_count,
      SUM(COALESCE(military_count,0)) AS military_count,
      MAX(COALESCE(max_altitude,0))  AS max_altitude,
      MAX(COALESCE(max_speed,0))     AS max_speed,
      COUNT(*)                       AS days_tracked
    FROM daily_stats
    GROUP BY year
    ORDER BY year DESC
  `).all();
}

function updateRecord(key, valueNum, valueText, callsign, detail, timestamp) {
  db.prepare(`
    INSERT INTO records (record_key, value_num, value_text, callsign, detail, achieved_at, achieved_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_key) DO UPDATE SET
      value_num     = excluded.value_num,
      value_text    = excluded.value_text,
      callsign      = excluded.callsign,
      detail        = excluded.detail,
      achieved_at   = excluded.achieved_at,
      achieved_date = excluded.achieved_date
  `).run(key, valueNum, valueText, callsign, detail, timestamp,
    new Date(timestamp).toISOString().slice(0, 10));
}

function getRecords() {
  const rows = db.prepare('SELECT * FROM records').all();
  return Object.fromEntries(rows.map(r => [r.record_key, r]));
}

function pruneSnapshots() {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  db.prepare('DELETE FROM aircraft_snapshots WHERE captured_at < ?').run(cutoff);
}

function hasRrdBackfillRows() {
  return db.prepare("SELECT COUNT(*) AS n FROM daily_stats WHERE source = 'rrd_backfill'").get().n > 0;
}

module.exports = {
  insertSnapshot, getRecentSnapshots, getSnapshotsByDate,
  getTodaySnapshots, getDayStats,
  upsertDailyStats, getDailyStats, getMonthlyStats, getYearlyStats,
  updateRecord, getRecords, pruneSnapshots, hasRrdBackfillRows,
  logFeederStatus, getFeederHistory
};
