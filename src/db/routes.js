const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/routes.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS adsbdb_cache (
    callsign      TEXT PRIMARY KEY,
    origin        TEXT,
    destination   TEXT,
    airline_name  TEXT,
    aircraft_type TEXT,
    fetched_at    INTEGER NOT NULL
  );
`);

// ── Migrations: richer route metadata from the routeset batch API ──
const cacheCols = db.prepare('PRAGMA table_info(adsbdb_cache)').all().map(c => c.name);
for (const col of ['origin_name', 'destination_name', 'origin_country', 'destination_country']) {
  if (!cacheCols.includes(col)) db.exec(`ALTER TABLE adsbdb_cache ADD COLUMN ${col} TEXT`);
}
for (const col of ['route_km', 'origin_lat', 'origin_lon', 'dest_lat', 'dest_lon']) {
  if (!cacheCols.includes(col)) db.exec(`ALTER TABLE adsbdb_cache ADD COLUMN ${col} REAL`);
}

// One-time cleanup (user_version 0 → 1): cirium is retired, and legacy cache
// rows from the old single-callsign adsbdb path have O/D but no airport coords.
// Drop the cirium table and clear coordless positive cache rows so the routeset
// path re-resolves them with full coords/country.
if (db.pragma('user_version', { simple: true }) < 1) {
  db.exec('DROP TABLE IF EXISTS cirium_routes');
  db.exec('DELETE FROM adsbdb_cache WHERE origin IS NOT NULL AND origin_lat IS NULL');
  db.pragma('user_version = 1');
}

const CACHE_TTL_MS     = 24 * 60 * 60 * 1000; // 24 hours for hits (so daily flight number route changes are caught immediately)
const CACHE_MISS_TTL_MS = 2 * 24 * 60 * 60 * 1000; //  2 days for misses (so once-blank callsigns recover)

function getCachedRoute(callsign) {
  const row = db.prepare('SELECT * FROM adsbdb_cache WHERE UPPER(callsign) = ?').get(callsign.toUpperCase());
  if (!row) return null;
  const ttl = row.origin ? CACHE_TTL_MS : CACHE_MISS_TTL_MS;
  if (Date.now() - row.fetched_at > ttl) return null;
  return row;
}

function upsertCachedRoute({ callsign, origin, destination, airline_name, aircraft_type,
                            origin_name, destination_name, origin_country, destination_country,
                            route_km, origin_lat, origin_lon, dest_lat, dest_lon }) {
  db.prepare(`
    INSERT OR REPLACE INTO adsbdb_cache
      (callsign, origin, destination, airline_name, aircraft_type,
       origin_name, destination_name, origin_country, destination_country,
       route_km, origin_lat, origin_lon, dest_lat, dest_lon, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(callsign.toUpperCase(), origin || null, destination || null, airline_name || null, aircraft_type || null,
         origin_name || null, destination_name || null, origin_country || null, destination_country || null,
         route_km != null ? route_km : null,
         origin_lat ?? null, origin_lon ?? null, dest_lat ?? null, dest_lon ?? null, Date.now());
}

// ── OpenSky historical flight cache ──────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS opensky_cache (
    icao24      TEXT NOT NULL,
    date_key    TEXT NOT NULL,
    origin      TEXT,
    destination TEXT,
    callsign    TEXT,
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (icao24, date_key)
  )
`);

// ── Aircraft registration / photo cache (adsbdb /aircraft/{hex}) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS registration_cache (
    hex          TEXT PRIMARY KEY,
    registration TEXT,
    icao_type    TEXT,
    type         TEXT,
    manufacturer TEXT,
    owner        TEXT,
    country      TEXT,
    photo_url    TEXT,
    photo_thumb  TEXT,
    fetched_at   INTEGER NOT NULL
  )
`);

const REG_TTL_MS      = 90 * 24 * 3600 * 1000; // 90 days for hits (registration is stable)
const REG_MISS_TTL_MS =  3 * 24 * 3600 * 1000; //  3 days for misses

function getCachedRegistration(hex) {
  const row = db.prepare('SELECT * FROM registration_cache WHERE hex = ?').get(hex.toLowerCase());
  if (!row) return null;
  const ttl = row.registration ? REG_TTL_MS : REG_MISS_TTL_MS;
  if (Date.now() - row.fetched_at > ttl) return null;
  return row;
}

function upsertRegistration({ hex, registration, icao_type, type, manufacturer, owner, country, photo_url, photo_thumb }) {
  db.prepare(`
    INSERT OR REPLACE INTO registration_cache
      (hex, registration, icao_type, type, manufacturer, owner, country, photo_url, photo_thumb, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hex.toLowerCase(), registration || null, icao_type || null, type || null, manufacturer || null,
         owner || null, country || null, photo_url || null, photo_thumb || null, Date.now());
}

const OPENSKY_TTL_MS = 14 * 24 * 3600 * 1000; // 14 days

function getCachedOpenSky(icao24, dateKey) {
  const row = db.prepare('SELECT * FROM opensky_cache WHERE icao24 = ? AND date_key = ?').get(icao24.toLowerCase(), dateKey);
  if (!row) return null;
  if (Date.now() - row.fetched_at > OPENSKY_TTL_MS) return null;
  return row;
}

function upsertOpenSkyCache({ icao24, dateKey, origin, destination, callsign }) {
  db.prepare(`
    INSERT OR REPLACE INTO opensky_cache (icao24, date_key, origin, destination, callsign, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(icao24.toLowerCase(), dateKey, origin || null, destination || null, callsign || null, Date.now());
}

function deleteCachedRoute(callsign) {
  db.prepare('DELETE FROM adsbdb_cache WHERE UPPER(callsign) = ?').run(callsign.toUpperCase());
}

module.exports = { getCachedRoute, upsertCachedRoute, getCachedOpenSky, upsertOpenSkyCache, getCachedRegistration, upsertRegistration, deleteCachedRoute };
