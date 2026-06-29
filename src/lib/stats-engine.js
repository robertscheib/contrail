const { exec } = require('child_process');
const {
  getSnapshotsByDate, upsertDailyStats, updateRecord, getRecords, hasRrdBackfillRows,
} = require('../db/stats');
const { routeNearHome } = require('./geo');
const { getSetting } = require('../db/settings');

const HOME_LAT = 41.6993;
const HOME_LON = -88.1081;
// Read live from settings so the domestic/international split can be changed
// at runtime without a restart.
const homeCountry = () => String(getSetting('home_country_iso') || 'US').toUpperCase();

const AIRPORT_COORDS = {
  'ORD': [41.9742,  -87.9073], 'MDW': [41.7868,  -87.7522],
  'MKE': [42.9472,  -87.8966], 'LAX': [33.9425, -118.4081],
  'JFK': [40.6413,  -73.7781], 'LHR': [51.4700,   -0.4543],
  'CDG': [49.0097,    2.5479], 'NRT': [35.7720,  140.3929],
  'DFW': [32.8998,  -97.0403], 'ATL': [33.6407,  -84.4277],
  'DEN': [39.8561, -104.6737], 'SEA': [47.4502, -122.3088],
  'SFO': [37.6213, -122.3790], 'MIA': [25.7959,  -80.2870],
  'BOS': [42.3656,  -71.0096], 'PHX': [33.4373, -112.0078],
  'MSP': [44.8848,  -93.2223], 'DTW': [42.2162,  -83.3554],
  'EWR': [40.6895,  -74.1745], 'IAH': [29.9902,  -95.3368],
  'LAS': [36.0840, -115.1537], 'CLT': [35.2140,  -80.9431],
  'SAN': [32.7338, -117.1933], 'RSW': [26.5362,  -81.7552],
  'MCO': [28.4312,  -81.3081], 'STL': [38.7499,  -90.3748],
};

function distKmAirport(lat, lon) {
  const dx = (lon - HOME_LON) * 83;
  const dy = (lat - HOME_LAT) * 111;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
}

function distKmBetween(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * 83;
  const dy = (lat2 - lat1) * 111;
  return Math.sqrt(dx * dx + dy * dy);
}

const MILITARY_HEX_PREFIXES = ['AE', '43C'];
const MILITARY_CALLSIGN_PREFIXES = [
  'RCH', 'REACH', 'DUKE', 'ARMY', 'NAVY', 'USAF', 'PAT', 'SAM',
  'AIR1', 'AIR2', 'EXEC', 'VENUS', 'TITUS', 'MARCO', 'IRON',
  'STEEL', 'COPPER', 'GOLD',
];
const AIRLINE_RE = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/;

// Phase 0 decision — set at startup by checkBackfillAvailability()
let BACKFILL_AVAILABLE = false;
let _backfillInfo = { available: false, days_backfilled: 0, date_range: null };

// RRD backfill reads collectd history from inside the ultrafeeder container —
// either locally or over SSH, depending on feeder_detect_mode (shares the same
// SSH builder as docker-health). Mode 'off' (or remote with no host) ⇒ unavailable.
const dockerInspect = require('./docker-inspect');
const RRD_PATH = '/var/lib/collectd/rrd/localhost/dump1090-localhost/dump1090_aircraft-recent.rrd';

// Build the shell command + child env to run a command inside ultrafeeder,
// honoring the detection mode. Returns null when backfill isn't reachable.
function ultrafeederCmd(inner) {
  const mode = getSetting('feeder_detect_mode');
  if (mode === 'local')  return { cmd: `docker exec ultrafeeder ${inner}`, env: {} };
  if (mode === 'remote') {
    const ctx = dockerInspect.context();
    if (!ctx.host) return null;
    const { prefix, env } = dockerInspect.buildSshPrefix(ctx);
    return { cmd: `${prefix} "docker exec ultrafeeder ${inner}"`, env };
  }
  return null; // off
}

async function checkBackfillAvailability() {
  return new Promise(resolve => {
    const built = ultrafeederCmd(`rrdtool info ${RRD_PATH}`);
    if (!built) {
      BACKFILL_AVAILABLE = false;
      _backfillInfo.available = false;
      console.log('[stats-engine] BACKFILL_AVAILABLE = false — feeder detection off / no SSH host');
      return resolve(false);
    }
    exec(
      `${built.cmd} 2>/dev/null | head -1`,
      { timeout: 12000, env: { ...process.env, ...built.env } },
      (err, stdout) => {
        BACKFILL_AVAILABLE = !err && stdout.includes('filename');
        _backfillInfo.available = BACKFILL_AVAILABLE;
        if (BACKFILL_AVAILABLE) {
          console.log('[stats-engine] BACKFILL_AVAILABLE = true (RRD accessible via docker exec ultrafeeder)');
        } else {
          console.log('[stats-engine] BACKFILL_AVAILABLE = false — stats history starts from today');
        }
        resolve(BACKFILL_AVAILABLE);
      }
    );
  });
}

// ── Aircraft classification ────────────────────────────────────

function isMilitary(ac) {
  const hex    = (ac.hex    || '').toUpperCase();
  const flight = (ac.flight || '').trim().toUpperCase();
  for (const p of MILITARY_HEX_PREFIXES) if (hex.startsWith(p)) return true;
  if (hex.startsWith('F') && hex.length === 6) return true;
  for (const p of MILITARY_CALLSIGN_PREFIXES) if (flight.startsWith(p)) return true;
  return false;
}

function classifyAircraft(ac) {
  if (isMilitary(ac)) return 'military';
  const flight = (ac.flight || '').trim().toUpperCase();
  if (flight && AIRLINE_RE.test(flight)) return 'commercial';
  if (!flight || /^\d+$/.test(flight) || /^N\d/.test(flight)) return 'ga';
  return 'unknown';
}

// ── Type normalization ─────────────────────────────────────────

function normalizeType(type) {
  if (!type) return type;
  // "A-320" → "A320", "A-321neo" → "A321neo"; does not affect "737-800" (digit-hyphen-digit)
  return type.replace(/\b([AB])-(\d)/g, '$1$2').trim();
}

// ── Snapshot processor ─────────────────────────────────────────

function distKm(lat, lon) {
  if (lat == null || lon == null) return null;
  const dx = (lon - HOME_LON) * 83;
  const dy = (lat - HOME_LAT) * 111;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
}

function processSnapshot(aircraftArray) {
  let commercial = 0, ga = 0, military = 0, unknown = 0;
  let max_altitude = null, max_speed = null;
  let min_altitude = null, min_alt_callsign = null;
  let min_speed = null, min_spd_callsign = null;
  let farthest_km = null, farthest_callsign = null;
  const type_breakdown = {};
  const top_callsigns = [];
  const military_callsigns = [];
  const emergency_squawks = [];

  for (const ac of aircraftArray) {
    const cls = classifyAircraft(ac);
    if      (cls === 'military')   military++;
    else if (cls === 'commercial') commercial++;
    else if (cls === 'ga')         ga++;
    else                           unknown++;

    const rawAlt = ac.alt_baro ?? ac.ft_baro ?? null;
    const alt = typeof rawAlt === 'number' ? rawAlt : null; // ignore "ground"
    if (alt != null && (max_altitude == null || alt > max_altitude)) max_altitude = alt;

    const cs0 = (ac.flight || '').trim() || ac.hex;
    // Lowest airborne aircraft (numeric altitude above ~500 ft to skip ground/approach noise)
    if (alt != null && alt > 500 && (min_altitude == null || alt < min_altitude)) {
      min_altitude = alt; min_alt_callsign = cs0;
    }

    const spd = typeof ac.gs === 'number' ? ac.gs : null;
    if (spd != null && (max_speed == null || spd > max_speed)) max_speed = spd;
    // Slowest airborne aircraft (moving, and airborne to skip taxiing/parked)
    if (spd != null && spd > 0 && alt != null && alt > 500 && (min_speed == null || spd < min_speed)) {
      min_speed = spd; min_spd_callsign = cs0;
    }

    const dist = distKm(ac.lat, ac.lon);
    if (dist != null && (farthest_km == null || dist > farthest_km)) {
      farthest_km = dist;
      farthest_callsign = (ac.flight || '').trim() || ac.hex;
    }

    const type = normalizeType(ac.desc || ac.t || null);
    if (type) type_breakdown[type] = (type_breakdown[type] || 0) + 1;

    const cs = (ac.flight || '').trim();
    if (cs && ac.lat != null && top_callsigns.length < 10) top_callsigns.push(cs);
    if (cls === 'military' && cs) military_callsigns.push(cs);

    const sq = String(ac.squawk || '');
    if (['7500', '7600', '7700'].includes(sq)) {
      emergency_squawks.push({ squawk: sq, callsign: cs || ac.hex });
    }
  }

  return {
    count: aircraftArray.length,
    commercial, ga, military, unknown,
    max_altitude, max_speed,
    min_altitude, min_alt_callsign,
    min_speed, min_spd_callsign,
    farthest_km, farthest_callsign,
    type_breakdown, top_callsigns, military_callsigns, emergency_squawks,
  };
}

// ── Records checker ────────────────────────────────────────────

async function checkAndUpdateRecords(snapshot, aircraftArray) {
  const records = getRecords();
  const now     = Date.now();
  const today   = new Date().toISOString().slice(0, 10);

  function beat(key, newVal, text, callsign, detail) {
    if (newVal == null) return;
    const ex = records[key];
    if (!ex || newVal > (ex.value_num ?? -Infinity)) {
      updateRecord(key, newVal, text, callsign, detail, now);
    }
  }

  function beatMin(key, newVal, text, callsign, detail) {
    if (newVal == null) return;
    const ex = records[key];
    if (!ex || newVal < (ex.value_num ?? Infinity)) {
      updateRecord(key, newVal, text, callsign, detail, now);
    }
  }

  beat('most_aircraft_at_once', snapshot.count,
    `${snapshot.count}`, null,
    `${snapshot.count} aircraft overhead on ${today}`);

  if (snapshot.max_altitude != null) {
    const ac = aircraftArray.find(a => (a.alt_baro ?? a.ft_baro) === snapshot.max_altitude);
    const cs = ac ? (ac.flight || '').trim() || ac.hex : null;
    beat('highest_altitude_ft', snapshot.max_altitude,
      `${snapshot.max_altitude.toLocaleString()} ft`, cs,
      `${cs || 'unknown'} at FL${Math.round(snapshot.max_altitude / 100)} on ${today}`);
  }

  if (snapshot.max_speed != null) {
    const ac = aircraftArray.find(a => a.gs === snapshot.max_speed);
    const cs = ac ? (ac.flight || '').trim() || ac.hex : null;
    beat('fastest_speed_kts', snapshot.max_speed,
      `${Math.round(snapshot.max_speed)} kts`, cs,
      `${cs || 'unknown'} at ${Math.round(snapshot.max_speed)} kts on ${today}`);
  }

  if (snapshot.min_speed != null) {
    beatMin('slowest_speed_kts', snapshot.min_speed,
      `${Math.round(snapshot.min_speed)} kts`, snapshot.min_spd_callsign,
      `${snapshot.min_spd_callsign || 'unknown'} at ${Math.round(snapshot.min_speed)} kts on ${today}`);
  }

  if (snapshot.min_altitude != null) {
    beatMin('lowest_altitude_ft', snapshot.min_altitude,
      `${Math.round(snapshot.min_altitude).toLocaleString()} ft`, snapshot.min_alt_callsign,
      `${snapshot.min_alt_callsign || 'unknown'} at ${Math.round(snapshot.min_altitude).toLocaleString()} ft on ${today}`);
  }

  if (snapshot.farthest_km != null) {
    beat('farthest_aircraft_km', snapshot.farthest_km,
      `${(snapshot.farthest_km * 0.621371).toFixed(1)} mi`, snapshot.farthest_callsign,
      `${snapshot.farthest_callsign || 'unknown'} at ${(snapshot.farthest_km * 0.621371).toFixed(1)} mi on ${today}`);
  }

  if (snapshot.military > 0) {
    beat('most_military_at_once', snapshot.military,
      `${snapshot.military}`, null,
      `${snapshot.military} military on ${today}: ${snapshot.military_callsigns.slice(0,3).join(', ')}`);
  }

  if (snapshot.commercial > 0) {
    beat('most_commercial_at_once', snapshot.commercial,
      `${snapshot.commercial}`, null,
      `${snapshot.commercial} commercial on ${today}`);
  }

  // Route-based records (only aircraft enriched with origin/destination)
  for (const ac of aircraftArray) {
    const cs = (ac.flight || '').trim();
    if (!cs || !ac.origin || !ac.destination) continue;

    const oCo = AIRPORT_COORDS[ac.origin];
    const dCo = AIRPORT_COORDS[ac.destination];

    if (oCo && dCo) {
      const nm = Math.round(distKmBetween(oCo[0], oCo[1], dCo[0], dCo[1]) / 1.852);
      beat('longest_stage_nm', nm, `${nm} nm`, cs,
        `${cs} ${ac.origin}→${ac.destination} ${nm} nm on ${today}`);
    }

    if (oCo) {
      const km = distKmAirport(oCo[0], oCo[1]);
      beat('farthest_origin_km', km, ac.origin, cs,
        `${cs} from ${ac.origin} (${(km * 0.621371).toFixed(1)} mi from home) on ${today}`);
    }

    if (dCo) {
      const km = distKmAirport(dCo[0], dCo[1]);
      beat('farthest_dest_km', km, ac.destination, cs,
        `${cs} to ${ac.destination} (${(km * 0.621371).toFixed(1)} mi from home) on ${today}`);
    }
  }

  // Oldest / youngest aircraft by manufacture year
  let oldestYear = null, oldestAc = null;
  let youngestYear = null, youngestAc = null;
  const currentYear = new Date().getFullYear();
  for (const ac of aircraftArray) {
    const yr = parseInt(ac.year, 10);
    if (!yr || yr < 1900 || yr > currentYear) continue;
    if (oldestYear === null || yr < oldestYear)   { oldestYear = yr;   oldestAc = ac; }
    if (youngestYear === null || yr > youngestYear) { youngestYear = yr; youngestAc = ac; }
  }
  if (oldestAc) {
    const cs   = (oldestAc.flight || '').trim() || oldestAc.hex;
    const desc = oldestAc.desc || oldestAc.t || '';
    beatMin('oldest_aircraft_year', oldestYear, String(oldestYear), cs,
      `${cs}${desc ? ' (' + desc + ')' : ''}, built ${oldestYear}, seen ${today}`);
  }
  if (youngestAc) {
    const cs   = (youngestAc.flight || '').trim() || youngestAc.hex;
    const desc = youngestAc.desc || youngestAc.t || '';
    beat('youngest_aircraft_year', youngestYear, String(youngestYear), cs,
      `${cs}${desc ? ' (' + desc + ')' : ''}, built ${youngestYear}, seen ${today}`);
  }
}

// ── Record set computation (shared by daily aggregation + period rollups) ──

// Direction each record is "best" in: 'max' = bigger wins, 'min' = smaller wins.
const RECORD_DIRS = {
  most_aircraft_at_once:  'max',
  highest_altitude_ft:    'max',
  fastest_speed_kts:      'max',
  slowest_speed_kts:      'min',
  lowest_altitude_ft:     'min',
  farthest_aircraft_km:   'max',
  longest_stage_nm:       'max',
  farthest_origin_km:     'max',
  farthest_dest_km:       'max',
  most_military_at_once:  'max',
  most_commercial_at_once:'max',
  oldest_aircraft_year:   'min',
  youngest_aircraft_year: 'max',
};

// Compute the full record set for an arbitrary list of snapshots (rows with
// aircraft_json). Pure — no DB writes. `dateLabel` is stamped as achieved_date
// and used in the human-readable detail string.
function computeRecordsForSnapshots(snapshots, dateLabel) {
  const out = {};
  const put = (key, val, text, cs, detail) => {
    if (val == null) return;
    const ex = out[key];
    const better = !ex || (RECORD_DIRS[key] === 'min' ? val < ex.value_num : val > ex.value_num);
    if (better) out[key] = { record_key: key, value_num: val, value_text: text,
      callsign: cs || null, detail: detail || null, achieved_date: dateLabel };
  };

  for (const snap of snapshots) {
    let aircraft;
    try { aircraft = JSON.parse(snap.aircraft_json); } catch { continue; }
    const proc = processSnapshot(aircraft);

    put('most_aircraft_at_once', proc.count, `${proc.count}`, null,
      `${proc.count} aircraft overhead on ${dateLabel}`);

    if (proc.max_altitude != null) {
      const ac = aircraft.find(a => (a.alt_baro ?? a.ft_baro) === proc.max_altitude);
      const cs = ac ? (ac.flight || '').trim() || ac.hex : null;
      put('highest_altitude_ft', proc.max_altitude, `${proc.max_altitude.toLocaleString()} ft`, cs,
        `${cs || 'unknown'} at FL${Math.round(proc.max_altitude / 100)} on ${dateLabel}`);
    }
    if (proc.max_speed != null) {
      const ac = aircraft.find(a => a.gs === proc.max_speed);
      const cs = ac ? (ac.flight || '').trim() || ac.hex : null;
      put('fastest_speed_kts', proc.max_speed, `${Math.round(proc.max_speed)} kts`, cs,
        `${cs || 'unknown'} at ${Math.round(proc.max_speed)} kts on ${dateLabel}`);
    }
    if (proc.min_speed != null) {
      put('slowest_speed_kts', proc.min_speed, `${Math.round(proc.min_speed)} kts`, proc.min_spd_callsign,
        `${proc.min_spd_callsign || 'unknown'} at ${Math.round(proc.min_speed)} kts on ${dateLabel}`);
    }
    if (proc.min_altitude != null) {
      put('lowest_altitude_ft', proc.min_altitude, `${Math.round(proc.min_altitude).toLocaleString()} ft`, proc.min_alt_callsign,
        `${proc.min_alt_callsign || 'unknown'} at ${Math.round(proc.min_altitude).toLocaleString()} ft on ${dateLabel}`);
    }
    if (proc.farthest_km != null) {
      put('farthest_aircraft_km', proc.farthest_km, `${(proc.farthest_km * 0.621371).toFixed(1)} mi`, proc.farthest_callsign,
        `${proc.farthest_callsign || 'unknown'} at ${(proc.farthest_km * 0.621371).toFixed(1)} mi on ${dateLabel}`);
    }
    if (proc.military > 0) {
      put('most_military_at_once', proc.military, `${proc.military}`, null,
        `${proc.military} military on ${dateLabel}: ${proc.military_callsigns.slice(0, 3).join(', ')}`);
    }
    if (proc.commercial > 0) {
      put('most_commercial_at_once', proc.commercial, `${proc.commercial}`, null,
        `${proc.commercial} commercial on ${dateLabel}`);
    }

    for (const ac of aircraft) {
      const cs = (ac.flight || '').trim();
      if (!cs || !ac.origin || !ac.destination) continue;
      const oCo = AIRPORT_COORDS[ac.origin];
      const dCo = AIRPORT_COORDS[ac.destination];
      if (oCo && dCo) {
        const nm = Math.round(distKmBetween(oCo[0], oCo[1], dCo[0], dCo[1]) / 1.852);
        put('longest_stage_nm', nm, `${nm} nm`, cs, `${cs} ${ac.origin}→${ac.destination} ${nm} nm on ${dateLabel}`);
      }
      if (oCo) {
        const km = distKmAirport(oCo[0], oCo[1]);
        put('farthest_origin_km', km, ac.origin, cs, `${cs} from ${ac.origin} (${(km * 0.621371).toFixed(1)} mi from home) on ${dateLabel}`);
      }
      if (dCo) {
        const km = distKmAirport(dCo[0], dCo[1]);
        put('farthest_dest_km', km, ac.destination, cs, `${cs} to ${ac.destination} (${(km * 0.621371).toFixed(1)} mi from home) on ${dateLabel}`);
      }
    }

    let oldestYear = null, oldestAc = null, youngestYear = null, youngestAc = null;
    const currentYear = new Date().getFullYear();
    for (const ac of aircraft) {
      const yr = parseInt(ac.year, 10);
      if (!yr || yr < 1900 || yr > currentYear) continue;
      if (oldestYear === null || yr < oldestYear)     { oldestYear = yr;   oldestAc = ac; }
      if (youngestYear === null || yr > youngestYear)  { youngestYear = yr; youngestAc = ac; }
    }
    if (oldestAc) {
      const cs = (oldestAc.flight || '').trim() || oldestAc.hex;
      const desc = oldestAc.desc || oldestAc.t || '';
      put('oldest_aircraft_year', oldestYear, String(oldestYear), cs,
        `${cs}${desc ? ' (' + desc + ')' : ''}, built ${oldestYear}, seen ${dateLabel}`);
    }
    if (youngestAc) {
      const cs = (youngestAc.flight || '').trim() || youngestAc.hex;
      const desc = youngestAc.desc || youngestAc.t || '';
      put('youngest_aircraft_year', youngestYear, String(youngestYear), cs,
        `${cs}${desc ? ' (' + desc + ')' : ''}, built ${youngestYear}, seen ${dateLabel}`);
    }
  }
  return out;
}

// Merge several record sets, keeping the best per key by RECORD_DIRS.
function mergeRecordSets(sets) {
  const out = {};
  for (const set of sets) {
    if (!set) continue;
    for (const key of Object.keys(set)) {
      const r = set[key];
      if (!r || r.value_num == null) continue;
      const ex = out[key];
      const better = !ex || (RECORD_DIRS[key] === 'min' ? r.value_num < ex.value_num : r.value_num > ex.value_num);
      if (better) out[key] = r;
    }
  }
  return out;
}

// ── Daily aggregator ───────────────────────────────────────────

function aggregateDay(date) {
  const snapshots = getSnapshotsByDate(date);
  if (snapshots.length === 0) {
    console.log(`[stats-engine] aggregateDay(${date}): no snapshots found`);
    return;
  }

  let max_aircraft = 0;
  let tot_commercial = 0, tot_ga = 0, tot_military = 0, tot_unknown = 0;
  let max_altitude = null, max_speed = null;
  let tot_altitude = 0, alt_count = 0;
  const seen_hex = new Set();
  const airline_counts = {};
  const hour_max = new Array(24).fill(0);
  const n = snapshots.length;

  // Per-hex deduplication for new JSON columns
  const hexType    = new Map();  // hex → last-seen normalized type
  const hexRoute   = new Map();  // hex → { origin, destination } (first enriched)
  const hexAirline = new Map();  // hex → ICAO prefix (first seen)

  for (const snap of snapshots) {
    let aircraft;
    try { aircraft = JSON.parse(snap.aircraft_json); } catch { continue; }

    const hour = new Date(snap.captured_at).getUTCHours();
    if (snap.aircraft_count > max_aircraft) max_aircraft = snap.aircraft_count;
    if (snap.aircraft_count > hour_max[hour]) hour_max[hour] = snap.aircraft_count;

    const proc = processSnapshot(aircraft);
    tot_commercial += proc.commercial;
    tot_ga         += proc.ga;
    tot_military   += proc.military;
    tot_unknown    += proc.unknown;

    for (const ac of aircraft) {
      seen_hex.add(ac.hex);

      const alt = ac.alt_baro ?? ac.ft_baro ?? null;
      if (alt != null) {
        if (max_altitude == null || alt > max_altitude) max_altitude = alt;
        tot_altitude += alt;
        alt_count++;
      }

      const spd = ac.gs ?? null;
      if (spd != null && (max_speed == null || spd > max_speed)) max_speed = Math.round(spd);

      const cs = (ac.flight || '').trim();
      if (cs && /^[A-Z]{2}/.test(cs)) {
        const iata = cs.slice(0, 2);
        airline_counts[iata] = (airline_counts[iata] || 0) + 1;
      }

      // type_breakdown_json — dedupe by hex, normalize
      const rawType = ac.desc || ac.t || null;
      if (rawType) hexType.set(ac.hex, normalizeType(rawType));

      // top_routes_json — first enriched occurrence per hex (validated routes; legacy backstop)
      if (ac.origin && ac.destination && !hexRoute.has(ac.hex) &&
          (ac.route_v >= 2 || routeNearHome(ac.origin, ac.destination))) {
        hexRoute.set(ac.hex, {
          origin: ac.origin, destination: ac.destination,
          origin_country: ac.origin_country || null,
          destination_country: ac.destination_country || null,
        });
      }

      // top_airlines_json — first ICAO prefix per hex
      if (cs && !hexAirline.has(ac.hex)) {
        const m = cs.match(/^([A-Z]{2,3})\d/);
        if (m) hexAirline.set(ac.hex, m[1]);
      }
    }
  }

  const peak_hour   = hour_max.indexOf(Math.max(...hour_max));
  const top_airline = Object.entries(airline_counts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

  // Build type_breakdown_json
  const typeCounts = {};
  for (const t of hexType.values()) typeCounts[t] = (typeCounts[t] || 0) + 1;
  const sortedTypes = Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).slice(0, 20);
  const type_breakdown_json = sortedTypes.length
    ? JSON.stringify(Object.fromEntries(sortedTypes)) : null;

  // Build top_routes_json
  const routeCounts = {};
  for (const { origin, destination } of hexRoute.values()) {
    const key = `${origin}→${destination}`;
    routeCounts[key] = (routeCounts[key] || 0) + 1;
  }
  const sortedRoutes = Object.entries(routeCounts).sort((a,b)=>b[1]-a[1]).slice(0, 20)
    .map(([k, v]) => { const [origin, destination] = k.split('→'); return { origin, destination, count: v }; });
  const top_routes_json = sortedRoutes.length ? JSON.stringify(sortedRoutes) : null;

  // Build top_airlines_json
  const airlinePfxCounts = {};
  for (const al of hexAirline.values()) airlinePfxCounts[al] = (airlinePfxCounts[al] || 0) + 1;
  const sortedAirlines = Object.entries(airlinePfxCounts).sort((a,b)=>b[1]-a[1]).slice(0, 20)
    .map(([k, v]) => ({ airline: k, count: v }));
  const top_airlines_json = sortedAirlines.length ? JSON.stringify(sortedAirlines) : null;

  // Build top_countries_json + top_airports_json (per-hex deduped, domestic vs intl)
  const countryCounts = {};
  const airportCounts = {};   // code → { count, country, domestic }
  for (const r of hexRoute.values()) {
    const seenC = new Set(), seenA = new Set();
    for (const [code, country] of [[r.origin, r.origin_country], [r.destination, r.destination_country]]) {
      if (country && !seenC.has(country)) { countryCounts[country] = (countryCounts[country] || 0) + 1; seenC.add(country); }
      if (code && !seenA.has(code)) {
        const hc = homeCountry();
        const a = airportCounts[code] || (airportCounts[code] = { count: 0, country: country || null, domestic: country ? country === hc : null });
        a.count++; seenA.add(code);
        if (!a.country && country) { a.country = country; a.domestic = country === hc; }
      }
    }
  }
  const sortedCountries = Object.entries(countryCounts).sort((a,b)=>b[1]-a[1]).slice(0, 20)
    .map(([country, count]) => ({ country, count }));
  const top_countries_json = sortedCountries.length ? JSON.stringify(sortedCountries) : null;

  const sortedAirports = Object.entries(airportCounts).sort((a,b)=>b[1].count-a[1].count).slice(0, 30)
    .map(([code, v]) => ({ code, count: v.count, country: v.country, domestic: v.domestic }));
  const top_airports_json = sortedAirports.length ? JSON.stringify(sortedAirports) : null;

  // Full per-day record set (every record type), so period rollups have real
  // data for all of them — not just the three scalar maxima.
  const dayRecords = computeRecordsForSnapshots(snapshots, date);

  // Self-heal the all-time records table from this day's set, so All Time is
  // never beaten by a period view (e.g. a slower aircraft surfaced on rollup
  // that the live per-snapshot checker missed). Keeps records always current.
  const allTime = getRecords();
  const dayTs = Date.parse(`${date}T12:00:00Z`);
  for (const key of Object.keys(dayRecords)) {
    const r = dayRecords[key], ex = allTime[key];
    if (r.value_num == null) continue;
    const better = !ex || (RECORD_DIRS[key] === 'min' ? r.value_num < ex.value_num : r.value_num > ex.value_num);
    if (better) updateRecord(key, r.value_num, r.value_text, r.callsign, r.detail, dayTs);
  }

  upsertDailyStats(date, {
    max_aircraft,
    total_seen:       seen_hex.size,
    peak_hour,
    commercial_count: Math.round(tot_commercial / n),
    ga_count:         Math.round(tot_ga / n),
    military_count:   Math.round(tot_military / n),
    unknown_count:    Math.round(tot_unknown / n),
    top_airline,
    top_route:        null,
    longest_flight_nm: dayRecords.longest_stage_nm?.value_num ?? null,
    farthest_origin:  dayRecords.farthest_origin_km?.value_text ?? null,
    farthest_origin_km: dayRecords.farthest_origin_km?.value_num ?? null,
    farthest_dest:    dayRecords.farthest_dest_km?.value_text ?? null,
    farthest_dest_km: dayRecords.farthest_dest_km?.value_num ?? null,
    avg_altitude:     alt_count > 0 ? Math.round(tot_altitude / alt_count) : null,
    max_altitude,
    max_speed,
    source: 'live',
    type_breakdown_json,
    top_routes_json,
    top_airlines_json,
    top_countries_json,
    top_airports_json,
    day_records_json: Object.keys(dayRecords).length ? JSON.stringify(dayRecords) : null,
  });

  console.log(`[stats-engine] aggregateDay(${date}): ${n} snapshots → max=${max_aircraft}`);
}

// ── RRD backfill ───────────────────────────────────────────────

async function backfillFromRRD() {
  if (!BACKFILL_AVAILABLE) {
    console.log('[stats-engine] backfillFromRRD: skipped (not available)');
    return;
  }
  if (hasRrdBackfillRows()) {
    console.log('[stats-engine] backfillFromRRD: already done, skipping');
    return;
  }

  const built = ultrafeederCmd(`rrdtool fetch ${RRD_PATH} MAX --start -26280h --resolution 28800`);
  if (!built) {
    console.warn('[stats-engine] backfillFromRRD: skipped (feeder detection off / no SSH host)');
    return;
  }
  const cmd = `${built.cmd} 2>/dev/null`;

  return new Promise(resolve => {
    exec(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...built.env } }, (err, stdout) => {
      if (err || !stdout) {
        console.warn('[stats-engine] backfillFromRRD: fetch failed —', err?.message);
        resolve();
        return;
      }

      const byDate = {};
      for (const line of stdout.split('\n')) {
        if (!line.includes(':')) continue;
        const colonIdx = line.indexOf(':');
        const ts  = parseInt(line.slice(0, colonIdx).trim());
        if (!ts || ts <= 0) continue;

        const valStr = line.slice(colonIdx + 1).trim().split(/\s+/)[0];
        if (!valStr || valStr === '-nan' || valStr === 'nan' || valStr === 'NaN') continue;
        const v = parseFloat(valStr);
        if (!isFinite(v) || v <= 0) continue;

        const count = Math.round(v);
        const date  = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!byDate[date] || count > byDate[date]) byDate[date] = count;
      }

      const dates = Object.keys(byDate).sort();
      let inserted = 0;

      for (const date of dates) {
        upsertDailyStats(date, {
          max_aircraft:  byDate[date],
          total_seen:    null,
          peak_hour:     null,
          commercial_count: null, ga_count: null,
          military_count: null,  unknown_count: null,
          top_airline:   null,   top_route:   null,
          longest_flight_nm: null,
          farthest_origin: null, farthest_origin_km: null,
          farthest_dest:   null, farthest_dest_km:   null,
          avg_altitude:  null,   max_altitude: null,
          max_speed:     null,
          source: 'rrd_backfill',
        });
        inserted++;
      }

      const range = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : 'none';
      _backfillInfo = { available: true, days_backfilled: inserted, date_range: range };
      console.log(`[stats-engine] backfillFromRRD: inserted ${inserted} days (${range})`);
      resolve();
    });
  });
}

function getBackfillInfo() { return { ..._backfillInfo }; }

module.exports = {
  normalizeType,
  classifyAircraft, processSnapshot, checkAndUpdateRecords,
  computeRecordsForSnapshots, mergeRecordSets, RECORD_DIRS,
  aggregateDay, backfillFromRRD, checkBackfillAvailability, getBackfillInfo,
};
