const fetch = require('node-fetch');
const { getCachedRoute, upsertCachedRoute, getCachedOpenSky, upsertOpenSkyCache } = require('../db/routes');

// ── N-number ↔ ICAO24 hex conversion ─────────────────────────────
// FAA encoding: US block 0xA00001..0xAFFFFF
// Each ≤3-digit number has 601 slots (1 no-suffix + 24 one-letter + 576 two-letter)
// 4-digit numbers have 25 slots (1 + 24 one-letter only)
// 5-digit numbers have 1 slot (no suffix)
const N_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 chars, no I or O

function nNumberToIcao24(nNumber) {
  const s = String(nNumber).toUpperCase().replace(/^N/, '');
  const m = s.match(/^(\d{1,5})([A-Z]{0,2})$/);
  if (!m) return null;

  const d   = parseInt(m[1], 10);
  const suf = m[2] || '';
  if (d < 1 || d > 99999) return null;

  for (const c of suf) {
    if (!N_CHARSET.includes(c)) return null;
  }

  const digitLen = d.toString().length;
  const maxSuf   = digitLen <= 3 ? 2 : digitLen === 4 ? 1 : 0;
  if (suf.length > maxSuf) return null;

  const prev3 = Math.min(d - 1, 999);
  const prev4 = Math.max(0, Math.min(d - 1, 9999) - 999);
  const prev5 = Math.max(0, (d - 1) - 9999);
  const base  = prev3 * 601 + prev4 * 25 + prev5;

  let sub = 0;
  if (suf.length === 1) {
    const i1 = N_CHARSET.indexOf(suf[0]);
    sub = digitLen <= 3 ? (1 + i1 * 25) : (1 + i1);
  } else if (suf.length === 2) {
    sub = 2 + N_CHARSET.indexOf(suf[0]) * 25 + N_CHARSET.indexOf(suf[1]);
  }

  return (0xA00001 + base + sub).toString(16).padStart(6, '0');
}

// Reverse: ICAO24 hex → N-number (US block only). Returns null for non-US.
function icao24ToNNumber(hex) {
  const val = parseInt(hex, 16);
  if (isNaN(val) || val < 0xA00001 || val > 0xAFFFFF) return null;

  const offset  = val - 0xA00001;
  const BUCKET3 = 999 * 601;   // 600,399 — ≤3-digit N-numbers
  const BUCKET4 = 9000 * 25;   // 225,000 — 4-digit N-numbers

  let d, rem, maxSuf;
  if (offset < BUCKET3) {
    d      = Math.floor(offset / 601) + 1;
    rem    = offset % 601;
    maxSuf = 2;
  } else if (offset < BUCKET3 + BUCKET4) {
    const o4 = offset - BUCKET3;
    d      = Math.floor(o4 / 25) + 1000;
    rem    = o4 % 25;
    maxSuf = 1;
  } else {
    d      = (offset - BUCKET3 - BUCKET4) + 10000;
    rem    = 0;
    maxSuf = 0;
  }

  let suf = '';
  if (rem > 0) {
    if (maxSuf === 1) {
      suf = N_CHARSET[rem - 1];
    } else if (maxSuf === 2) {
      const i1 = Math.floor((rem - 1) / 25);
      const pos = (rem - 1) % 25;
      suf = pos === 0 ? N_CHARSET[i1] : N_CHARSET[i1] + N_CHARSET[pos - 1];
    }
  }

  if (d < 1 || d > 99999) return null;
  return 'N' + d + suf;
}

// ── OpenSky historical flight lookup ─────────────────────────────
const ICAO_TO_IATA = require('../data/icao_to_iata.json'); // OurAirports ICAO→IATA
// Converts an ICAO 4-letter airport code to IATA 3-letter via the airport DB
// (EHAM → AMS, RJTT → HND), with a heuristic fallback for unknowns (KORD → ORD).
function icaoAptToIata(code) {
  if (!code) return null;
  const c = code.toUpperCase();
  if (ICAO_TO_IATA[c]) return ICAO_TO_IATA[c];
  if (/^[KC][A-Z]{3}$/.test(c)) return c.slice(1);       // US/Canada fallback
  if (c.length === 4)           return c.slice(1);        // best-effort others
  return c;
}

// Look up an aircraft's ACTUAL recent flight by hex from OpenSky (departure /
// arrival airport, IATA). Cached in opensky_cache (hits and misses). Works for
// any hex — unlike resolveHistoricalRoute it does NOT short-circuit US N-numbers,
// so it can confirm US airliners. Returns { origin, destination, callsign } | null.
async function openSkyFlight(rawHex, achievedAtMs, { backHours = 4, fwdHours = 4 } = {}) {
  const hex     = rawHex.toLowerCase();
  const dateKey = new Date(achievedAtMs).toISOString().slice(0, 10);

  const cached = getCachedOpenSky(hex, dateKey);
  if (cached !== null) {
    if (!cached.origin && !cached.destination) return null;
    return { origin: cached.origin, destination: cached.destination, callsign: cached.callsign };
  }

  // OpenSky returns a flight only if its departure (firstSeen) falls in the window,
  // so a long-haul still airborne needs a wide look-back to capture its origin.
  const begin = Math.floor(achievedAtMs / 1000) - backHours * 3600;
  const end   = Math.floor(achievedAtMs / 1000) + fwdHours * 3600;
  const url   = `https://opensky-network.org/api/flights/aircraft?icao24=${hex}&begin=${begin}&end=${end}`;

  // Optional: add basic auth if OPENSKY_USER / OPENSKY_PASS are set
  const headers = {};
  if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
    const creds = Buffer.from(`${process.env.OPENSKY_USER}:${process.env.OPENSKY_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      upsertOpenSkyCache({ icao24: hex, dateKey, origin: null, destination: null, callsign: null });
      return null;
    }

    const flights = await res.json();
    if (!Array.isArray(flights) || !flights.length) {
      upsertOpenSkyCache({ icao24: hex, dateKey, origin: null, destination: null, callsign: null });
      return null;
    }

    const targetTs = Math.floor(achievedAtMs / 1000);
    const flight   = flights.find(f => f.firstSeen <= targetTs && (f.lastSeen || Infinity) >= targetTs)
      || flights.sort((a, b) =>
        Math.abs(((a.firstSeen + (a.lastSeen || a.firstSeen)) / 2) - targetTs) -
        Math.abs(((b.firstSeen + (b.lastSeen || b.firstSeen)) / 2) - targetTs)
      )[0];

    const origin      = icaoAptToIata(flight.estDepartureAirport);
    const destination = icaoAptToIata(flight.estArrivalAirport);
    const callsign    = (flight.callsign || '').trim() || null;

    upsertOpenSkyCache({ icao24: hex, dateKey, origin, destination, callsign });
    return { origin, destination, callsign };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function resolveHistoricalRoute(icao24, achievedAtMs) {
  const hex = icao24.toLowerCase();

  // If the hex decodes to a US N-number, this is a GA aircraft that didn't
  // broadcast a callsign. Skip OpenSky — it associates nearby commercial
  // flights to the time window and returns false positives for GA.
  const nNumber = icao24ToNNumber(hex);
  if (nNumber) return { nNumber, isGA: true, source: 'faa-decode' };

  const f = await openSkyFlight(hex, achievedAtMs);
  if (!f) return null;
  return { ...f, source: 'opensky' };
}

// ── Routeset batch API (adsb.im / adsb.lol) ──────────────────────
// Same endpoint tar1090 and skystats use. Accepts callsign + position and
// returns plausibility-filtered routes with full airport metadata. One POST
// resolves up to ~100 aircraft, so the snapshot cron enriches every aircraft
// instead of the previous 8-per-cycle adsbdb cap.
const ROUTESET_URL = process.env.ROUTESET_URL || 'https://adsb.im/api/0/routeset';

function kmBetween(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null)) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Map one routeset result object → our normalized route record (or null).
// Keeps only plausible, direct (2-airport) routes — matches skystats filtering.
function parseRoutesetEntry(entry, { requirePlausible = true } = {}) {
  if (!entry) return null;
  if (requirePlausible && entry.plausible === false) return null;
  const aps = entry._airports;
  if (!Array.isArray(aps) || aps.length !== 2) return null; // skip unknown / multi-leg
  const [o, d] = aps;
  if (!o?.iata || !d?.iata) return null;
  return {
    origin:              o.iata,
    destination:         d.iata,
    origin_name:         o.name || null,
    destination_name:    d.name || null,
    origin_country:      o.countryiso2 || null,
    destination_country: d.countryiso2 || null,
    airline_name:        entry.airline_code || null, // ICAO operator code
    route_km:            kmBetween(o.lat, o.lon, d.lat, d.lon),
    origin_lat:          o.lat ?? null,
    origin_lon:          o.lon ?? null,
    dest_lat:            d.lat ?? null,
    dest_lon:            d.lon ?? null,
  };
}

// planes: [{ callsign, lat, lng }] (lat/lng optional). Returns Map<callsign, routeRecord>.
async function resolveRoutesBatch(planes, { requirePlausible = true } = {}) {
  const out = new Map();
  const valid = planes.filter(p => (p.callsign || '').trim()).slice(0, 100);
  if (!valid.length) return out;

  const body = {
    planes: valid.map(p => ({
      callsign: p.callsign.trim().toUpperCase(),
      lat: p.lat != null ? p.lat : 0,
      lng: p.lng != null ? p.lng : 0,
    })),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(ROUTESET_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'radar-dash/1.0' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return out;
    const arr = await res.json();
    if (!Array.isArray(arr)) return out;
    for (const entry of arr) {
      const cs = (entry.callsign || '').trim().toUpperCase();
      if (!cs) continue;
      const rec = parseRoutesetEntry(entry, { requirePlausible });
      if (rec) out.set(cs, rec);
    }
  } catch {
    clearTimeout(timer);
  }
  return out;
}

async function resolveRoute(rawCallsign) {
  const callsign = rawCallsign.trim().toUpperCase();

  // 1. adsbdb / routeset cache
  const cached = getCachedRoute(callsign);
  if (cached !== null) {
    if (!cached.origin) return null; // null entry cached for unknown callsign
    return { origin: cached.origin, destination: cached.destination, airline_name: cached.airline_name, source: 'cache' };
  }

  // 2. Routeset batch API (single callsign, no position → accept regardless of plausibility)
  const batch = await resolveRoutesBatch([{ callsign }], { requirePlausible: false });
  const rs = batch.get(callsign);
  if (rs) {
    upsertCachedRoute({ callsign, aircraft_type: null, ...rs });
    return { ...rs, source: 'routeset' };
  }

  // 3. Fetch from adsbdb.com
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${callsign}`, { signal: ctrl.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const fr = data?.response?.flightroute;
      if (fr) {
        const origin       = fr.origin?.iata_code      || null;
        const destination  = fr.destination?.iata_code || null;
        const airline_name = fr.airline?.name           || null;

        upsertCachedRoute({ callsign, origin, destination, airline_name, aircraft_type: null });
        return { origin, destination, airline_name, source: 'adsbdb' };
      }
    }
  } catch (e) {
    clearTimeout(timer);
  }

  // 4. Fallback: FlightAware AeroAPI
  try {
    const { getAeroApiRoute } = require('./aeroapi');
    const aeroRoute = await getAeroApiRoute(callsign);
    if (aeroRoute) {
      upsertCachedRoute({ callsign, aircraft_type: null, ...aeroRoute });
      return { ...aeroRoute, source: 'aeroapi' };
    }
  } catch (err) {
    console.error('[aeroapi] Route lookup failed:', err.message);
  }

  // Cache negative result so we don't spam APIs for unknown callsigns
  upsertCachedRoute({ callsign, origin: null, destination: null, airline_name: null, aircraft_type: null });
  return null;
}

module.exports = { resolveRoute, resolveRoutesBatch, resolveHistoricalRoute, openSkyFlight, nNumberToIcao24, icao24ToNNumber };
