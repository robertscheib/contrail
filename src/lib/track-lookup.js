// Resolve the ACTUAL flown track (wide-area, beyond our own receiver) for an
// aircraft, so the map can draw the whole flight — not just the portion we saw.
//
// Primary source: ADSBExchange globe "trace" (the file the adsbexchange.com globe
// UI uses). It spans the entire ADSBEx network, so it covers the full flight.
// It is an undocumented endpoint — we cache hard and only ever call it for the
// handful of aircraft currently overhead, to stay polite.
// Fallback: OpenSky tracks/all — sanctioned, but usually only a short recent
// segment near us, so it's a last resort when ADSBEx has nothing.
const fetch = require('node-fetch');

const ADSBX_BASE = process.env.ADSBX_TRACE_URL || 'https://globe.adsbexchange.com/data/traces';

// In-memory cache. Tracks change as the aircraft moves, so keep it short.
const POS_TTL_MS = 120_000;   // 2 min for a resolved track
const NEG_TTL_MS = 300_000;   // 5 min before retrying a miss
const MAX_ENTRIES = 500;
const _cache = new Map();      // hex → { at, data }

// Health/diagnostics for the track sources (surfaced on the settings page).
const _stats = { adsbex: 0, opensky: 0, none: 0, adsbex_http_fail: 0, last_fail_at: null, last_ok_at: null };
function getTrackStats() {
  // Flag a problem when the primary source (ADSBEx) is producing nothing but
  // its HTTP calls are failing — i.e. likely blocked/unreachable, not just a GA
  // aircraft with no history.
  const failing = _stats.adsbex === 0 && _stats.adsbex_http_fail > 0;
  return { ..._stats, failing };
}

function _cacheGet(hex) {
  const e = _cache.get(hex);
  if (!e) return undefined;
  const ttl = e.data ? POS_TTL_MS : NEG_TTL_MS;
  if (Date.now() - e.at > ttl) { _cache.delete(hex); return undefined; }
  return e.data;
}
function _cacheSet(hex, data) {
  if (_cache.size >= MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
  _cache.set(hex, { at: Date.now(), data });
}

async function _fetchJson(url, headers = {}, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ADSBExchange trace → [{ lat, lon, alt }]. Trace rows are
// [time_offset, lat, lon, alt_baro(|"ground"), gs, track, flags, vrate, ...].
async function _adsbxTrace(hex) {
  const sub = hex.slice(-2);
  // Prefer the FULL trace (whole flight from departure) over recent (~last hour).
  for (const kind of ['full', 'recent']) {
    const url = `${ADSBX_BASE}/${sub}/trace_${kind}_${hex}.json`;
    const j = await _fetchJson(url, {
      'User-Agent': 'Mozilla/5.0 (radar-dash; ADSBEx feeder)',
      'Referer': 'https://globe.adsbexchange.com/',
      'Accept': 'application/json',
    });
    if (j === null) { _stats.adsbex_http_fail++; _stats.last_fail_at = Date.now(); } // HTTP/network error (e.g. blocked)
    const rows = j && Array.isArray(j.trace) ? j.trace : null;
    if (!rows || !rows.length) continue;
    const points = _currentLeg(rows);     // only the latest flight, not the whole day
    if (points.length >= 2) {
      return { source: 'adsbexchange', registration: j.r || null, type: j.t || null, points: _decimate(points, 600) };
    }
  }
  return null;
}

// An ADSBEx trace spans the aircraft's whole recent history (often several flights).
// Extract just the CURRENT leg, and within it insert `null` break markers at
// coverage gaps so the map draws a clean break instead of a straight chord across
// the hole. A new flight (ground stop / ≥30 min gap) discards the prior leg;
// a shorter gap (>2 min, i.e. a reception dropout) becomes a visual break.
// Rows: [t_offset, lat, lon, alt(|"ground"), gs, track, ...].
function _currentLeg(rows) {
  const LEG_GAP_S   = 1800;     // ≥30 min ⇒ a different flight (drop prior leg)
  const BREAK_GAP_S = 120;      // >2 min  ⇒ coverage gap (break the line)
  let leg = [], prevT = null;
  for (const row of rows) {
    const t = row[0], lat = row[1], lon = row[2], alt = row[3];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const onGround = alt === 'ground';
    const dt = (prevT != null && typeof t === 'number') ? (t - prevT) : 0;
    if (onGround || dt > LEG_GAP_S) leg = [];                      // new flight
    else if (dt > BREAK_GAP_S && leg.length && leg[leg.length - 1]) leg.push(null);  // gap → break
    if (!onGround) leg.push({
      lat,
      lon,
      alt: typeof alt === 'number' ? alt : null,
      gs: typeof row[4] === 'number' ? row[4] : null,
      t: typeof t === 'number' ? t : null
    });
    if (typeof t === 'number') prevT = t;
  }
  while (leg.length && !leg[0]) leg.shift();
  while (leg.length && !leg[leg.length - 1]) leg.pop();
  return leg;
}

// Cap a track to at most `max` points by uniform sampling, preserving `null`
// break markers (decimate each contiguous segment proportionally to its length).
function _decimate(points, max) {
  if (points.some(p => p === null)) {
    const segs = [];
    let cur = [];
    for (const p of points) { if (p === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
    if (cur.length) segs.push(cur);
    const total = segs.reduce((n, s) => n + s.length, 0);
    const out = [];
    segs.forEach((s, i) => {
      if (i) out.push(null);
      out.push(..._decimate(s, Math.max(2, Math.round(max * s.length / total))));
    });
    return out;
  }
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// OpenSky tracks/all → [{ lat, lon, alt }]. path rows are
// [time, lat, lon, baro_altitude, true_track, on_ground].
async function _openSkyTrack(hex) {
  const headers = {};
  if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
    headers['Authorization'] = 'Basic ' +
      Buffer.from(`${process.env.OPENSKY_USER}:${process.env.OPENSKY_PASS}`).toString('base64');
  }
  const j = await _fetchJson(`https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`, headers);
  const rows = j && Array.isArray(j.path) ? j.path : null;
  if (!rows || rows.length < 2) return null;
  const points = [];
  for (const row of rows) {
    const lat = row[1], lon = row[2];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    points.push({ lat, lon, alt: typeof row[3] === 'number' ? row[3] : null });
  }
  return points.length >= 2 ? { source: 'opensky', points } : null;
}

// Resolve a track for one hex: ADSBEx, then OpenSky. Cached (incl. misses).
async function resolveTrack(rawHex) {
  const hex = (rawHex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  const cached = _cacheGet(hex);
  if (cached !== undefined) return cached;

  let track = await _adsbxTrace(hex);
  if (track) { _stats.adsbex++; _stats.last_ok_at = Date.now(); }
  else {
    track = await _openSkyTrack(hex);
    if (track) { _stats.opensky++; _stats.last_ok_at = Date.now(); }
    else _stats.none++;
  }
  _cacheSet(hex, track || null);
  return track;
}

module.exports = { resolveTrack, getTrackStats };
