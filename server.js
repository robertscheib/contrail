const fs = require('fs');
// Load project-local .env first (the public-friendly default), then a shared secrets
// file if one exists (back-compat for deployments that keep credentials in a shared
// ~/projects/secrets.env loaded via systemd EnvironmentFile); SECRETS_PATH overrides.
require('dotenv').config();
const _sharedSecrets = process.env.SECRETS_PATH || (process.env.HOME && `${process.env.HOME}/projects/secrets.env`);
if (_sharedSecrets && fs.existsSync(_sharedSecrets)) require('dotenv').config({ path: _sharedSecrets });

const express    = require('express');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const adsbRouter = require('./adsb');
const { resolveRoute, resolveRoutesBatch, resolveHistoricalRoute, openSkyFlight, nNumberToIcao24, icao24ToNNumber } = require('./src/lib/route-lookup');
const { resolveRegistration } = require('./src/lib/registration-lookup');
const { getInteresting, recordSighting, getRecentSightings, getWatchlistLeaderboard, interestingCount, pruneSightings, getWatchlist, deleteWatchlist, upsertWatchlist } = require('./src/db/interesting');
const { loadPlaneAlertDb } = require('./src/lib/plane-alert');
const { triggerNotification } = require('./src/lib/notifications');


// ── Stats modules ────────────────────────────────────────────────
const {
  insertSnapshot, pruneSnapshots, getRecentSnapshots, getSnapshotsByDate,
  getTodaySnapshots, getDayStats,
  getDailyStats, getMonthlyStats, getYearlyStats, getRecords,
  logFeederStatus, getFeederHistory,
} = require('./src/db/stats');
const {
  processSnapshot, checkAndUpdateRecords, aggregateDay,
  computeRecordsForSnapshots, mergeRecordSets, RECORD_DIRS,
  backfillFromRRD, checkBackfillAvailability, getBackfillInfo,
} = require('./src/lib/stats-engine');
const { getCachedRoute, upsertCachedRoute, getCachedRegistration, getCachedOpenSky } = require('./src/db/routes');
const { routeNearHome, routeOnPath } = require('./src/lib/geo');
const { getSetting, getAllSettings, getRedactedSettings, getSchema, updateSettings } = require('./src/db/settings');
const { resolveTrack, getTrackStats } = require('./src/lib/track-lookup');
const { getUpdateStatus, refresh: refreshUpdateCheck } = require('./src/lib/update-check');
const { upsertLeg, touchLeg, getLegMeta, pruneLegs, legCount, allPoints, allLegs } = require('./src/db/pathheat');

// ── Snapshot route enrichment ────────────────────────────────────
// Resolve origin/destination for every aircraft in a snapshot from the local
// cache first, then one batched routeset POST for the misses. Mutates aircraft
// objects in place, attaching origin/destination (IATA) + country codes +
// route_km. A cache hit that has O/D but no airport coords (legacy entry) is
// applied now AND re-queued so routeset can upgrade it with coords/country.
async function enrichSnapshotRoutes(aircraft) {
  // Attach a route only if the aircraft is plausibly flying it. For positioned
  // aircraft we use a detour test against the actual position (routeOnPath) — this
  // KEEPS real diversions/reroutes while dropping callsign collisions like PDX→LAS.
  // Positionless aircraft fall back to the home great-circle check. Validated
  // routes are tagged route_v=2 so aggregation trusts them without re-filtering.
  const attach = (ac, row) => {
    ac.origin = row.origin; ac.destination = row.destination;
    if (row.origin_country)      ac.origin_country      = row.origin_country;
    if (row.destination_country) ac.destination_country = row.destination_country;
    if (row.route_km != null)    ac.route_km            = row.route_km;
  };

  // Returns 'ok' (attached), 'far' (positioned but off-path — verify later), or 'drop'.
  const applyCached = (ac, row) => {
    const coords = { oLat: row.origin_lat, oLon: row.origin_lon, dLat: row.dest_lat, dLon: row.dest_lon };
    if (ac.lat != null && ac.lon != null) {
      if (routeOnPath(row.origin, row.destination, ac.lat, ac.lon, coords, getSetting('route_max_detour_km'))) { attach(ac, row); ac.route_v = 2; return 'ok'; }
      return 'far'; // off the direct path — could be a real far diversion; verify by hex history
    }
    if (routeNearHome(row.origin, row.destination, coords, getSetting('route_max_crosstrack_km'))) { attach(ac, row); ac.route_v = 2; return 'ok'; }
    return 'drop';
  };

  const need = [];          // cache misses to resolve via routeset
  const farCandidates = []; // { ac, row } positioned routes that failed the detour test
  for (const ac of aircraft) {
    const cs = (ac.flight || '').trim().toUpperCase();
    if (!cs) continue;

    const cached = getCachedRoute(cs);
    if (cached === null) {                                  // miss → resolve via routeset
      if (ac.lat != null && ac.lon != null) need.push(ac);
      continue;
    }
    if (!cached.origin) continue;                           // fresh negative cache → back off
    const r = applyCached(ac, cached);
    if (r === 'far') farCandidates.push({ ac, row: cached });
    else if (r === 'ok' && cached.origin_lat == null && ac.lat != null && ac.lon != null) need.push(ac); // upgrade coords
  }

  if (need.length) {
    // requirePlausible:false — routeset returns the scheduled route regardless of its
    // own position check; our detour test decides, so genuine diversions aren't pre-dropped.
    const batch = await resolveRoutesBatch(
      need.map(ac => ({ callsign: (ac.flight || '').trim(), lat: ac.lat, lng: ac.lon })),
      { requirePlausible: false }
    );
    for (const ac of need) {
      const cs  = (ac.flight || '').trim().toUpperCase();
      const rec = batch.get(cs);
      if (rec) {
        upsertCachedRoute({ callsign: cs, aircraft_type: null, ...rec });
        const r = applyCached(ac, rec);
        if (r === 'far') farCandidates.push({ ac, row: rec });
      } else if (!ac.origin) {
        upsertCachedRoute({ callsign: cs, origin: null, destination: null, airline_name: null, aircraft_type: null });
      }
    }
  }

  await verifyFarRoutes(farCandidates, attach);
}

// For routes that failed the detour test, confirm via the aircraft's ACTUAL flight
// history (OpenSky by hex): if it really departed the route's origin, it's a genuine
// far diversion — keep it. Bounded network budget per cycle; results cached 14 days.
const FAR_VERIFY_BUDGET = parseInt(process.env.FAR_VERIFY_BUDGET || '4', 10);
async function verifyFarRoutes(farCandidates, attach) {
  if (!farCandidates.length) return;
  const dateKey = new Date().toISOString().slice(0, 10);
  const confirm = ({ ac, row }, actual) => {
    if (actual?.origin && actual.origin.toUpperCase() === (row.origin || '').toUpperCase()) {
      attach(ac, row); ac.route_v = 3; // verified diversion
    }
  };

  const tasks = [];
  let netUsed = 0;
  for (const cand of farCandidates) {
    const hex = (cand.ac.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;
    const cached = getCachedOpenSky(hex, dateKey);
    if (cached !== null) { confirm(cand, cached.origin ? cached : null); continue; } // free
    if (netUsed >= FAR_VERIFY_BUDGET) continue;            // defer to a later cycle
    netUsed++;
    // Wide look-back so a long-haul that departed many hours ago is still found.
    tasks.push(openSkyFlight(hex, Date.now(), { backHours: 20, fwdHours: 2 })
      .then(actual => confirm(cand, actual)).catch(() => {}));
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

// Warm the registration/photo cache for the nearest aircraft each cycle. Bounded
// so we respect adsbdb rate limits; resolveRegistration() skips already-cached hexes.
async function enrichSnapshotRegistrations(aircraft, limit = 25) {
  const nearest = aircraft
    .filter(ac => /^[0-9a-f]{6}$/i.test(ac.hex || '') && ac.dist_nm != null)
    .sort((a, b) => a.dist_nm - b.dist_nm)
    .slice(0, limit);
  await Promise.allSettled(nearest.map(ac => resolveRegistration(ac.hex)));
}

// Flag any snapshot aircraft present in the plane-alert-db, or squawking emergency codes, and log de-duped sightings.
function flagInterestingAircraft(aircraft) {
  for (const ac of aircraft) {
    const hex = (ac.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;

    const isEmergencySquawk = ['7500', '7600', '7700'].includes(ac.squawk || '');
    let match = getInteresting(hex);

    if (!match && isEmergencySquawk) {
      // Create a mock match object for emergency squawks not on the watchlist
      const emergencyType = ac.squawk === '7500' ? 'Hijack (7500)' : ac.squawk === '7600' ? 'Radio Failure (7600)' : 'Emergency (7700)';
      match = {
        icao: hex,
        registration: ac.r || ac.reg || 'Unknown',
        operator: ac.op || 'Emergency Squawk',
        type: ac.t || 'Emergency',
        category: 'other',
        tag1: 'EMERGENCY',
        tag2: `Squawk ${ac.squawk}`,
        tag3: emergencyType,
        link: `https://globe.adsbexchange.com/?icao=${hex}`,
        image_link: null
      };
    }

    if (!match) continue;

    // If it is on the watchlist but ALSO has an emergency squawk, override/prepend emergency tags
    if (isEmergencySquawk) {
      match = {
        ...match,
        tag1: 'EMERGENCY',
        tag2: `Squawk ${ac.squawk}`,
        tag3: match.tag1 || 'Watchlist'
      };
    }

    const recorded = recordSighting({
      icao:   hex,
      flight: (ac.flight || '').trim() || null,
      lat:    ac.lat ?? null,
      lon:    ac.lon ?? null,
      alt:    ac.alt_baro ?? ac.ft_baro ?? null,
      squawk: ac.squawk || null,
    });

    if (recorded) {
      triggerNotification(ac, match).catch(err => {
        console.error(`[notify] Failed to send notification for ${hex}:`, err.message);
      });
    }
  }
}

const app  = express();
const PORT = process.env.RADAR_DASH_PORT || 3010;

// Trust X-Forwarded-For from upstream proxy (NPM)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',   'nosniff');
  res.setHeader('X-Frame-Options',          'SAMEORIGIN');
  res.setHeader('Referrer-Policy',          'strict-origin-when-cross-origin');
  next();
});

// Rate limits
app.use('/api/adsb/aircraft', rateLimit({ windowMs: 60_000, max: 120 }));
app.use('/api/adsb/live',     rateLimit({ windowMs: 60_000, max:  60 }));
app.use('/api/adsb/stats',    rateLimit({ windowMs: 60_000, max:  60 }));
app.use('/admin/stats/reaggregate', rateLimit({ windowMs: 3_600_000, max:  20 }));
app.use('/api/adsb/route',     rateLimit({ windowMs:    60_000, max: 60 }));

// ── Admin auth ───────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// Trust an authenticating proxy's identity header (e.g. Cloudflare Access).
// OPT-IN (default off): the header is trivially spoofable by anything that can reach
// this port directly, so it is ONLY safe when a proxy that sets/strips it actually
// fronts /admin. Enable with ADMIN_TRUST_PROXY_HEADER=true in that setup; otherwise
// auth is token-only.
const TRUST_PROXY_AUTH = process.env.ADMIN_TRUST_PROXY_HEADER === 'true';
// Escape hatch for trusted LAN / localhost-only installs: disables /admin auth
// entirely. OPT-IN and deliberately loud — never set this on an exposed host.
const ADMIN_NO_AUTH = process.env.ADMIN_DISABLE_AUTH === 'true';
if (ADMIN_NO_AUTH) {
  console.warn('[server] WARNING: /admin authentication DISABLED (ADMIN_DISABLE_AUTH=true) — do not expose this host.');
} else if (!ADMIN_TOKEN) {
  console.warn(TRUST_PROXY_AUTH
    ? '[server] ADMIN_TOKEN not set — /admin is reachable only via an authenticating proxy (cf-access header); direct access is denied.'
    : '[server] ADMIN_TOKEN not set — /admin is fully locked. Set ADMIN_TOKEN (and/or ADMIN_TRUST_PROXY_HEADER=true behind a proxy) to enable access.');
}

app.use('/admin', (req, res, next) => {
  // 0) Explicit local opt-out — auth fully disabled for trusted networks.
  if (ADMIN_NO_AUTH) return next();
  // 1) Authenticating proxy (Cloudflare Access / Zero Trust) — verified requests
  //    arrive with this header, so no app token is needed in-browser.
  if (TRUST_PROXY_AUTH && req.headers['cf-access-authenticated-user-email']) return next();
  // 2) Shared token — LAN/CLI fallback that bypasses the proxy edge.
  if (ADMIN_TOKEN) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token === ADMIN_TOKEN) return next();
  }
  // 3) Otherwise fail closed (previously fell open when no token was configured).
  if (req.accepts('html') && !req.xhr) {
    return res.status(401).send(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unauthorized</title>' +
      '<style>body{background:#0d1117;color:#e6edf3;font-family:ui-monospace,monospace;' +
      'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
      '.box{text-align:center}.code{color:#f85149;font-size:48px;margin-bottom:12px}' +
      '.msg{color:#8b949e;font-size:14px}</style></head><body>' +
      '<div class="box"><div class="code">401</div>' +
      '<div class="msg">Append <code>?token=YOUR_TOKEN</code> to the URL.</div></div></body></html>'
    );
  }
  return res.status(401).json({ error: 'Unauthorized' });
});

// Version / update status — used by the header to flag a newer release (Docker).
app.get('/api/update', (req, res) => {
  res.json(getUpdateStatus());
});

app.get('/api/adsb/route/:callsign', async (req, res) => {
  const callsign = (req.params.callsign || '').trim().toUpperCase();
  try {
    const result = await resolveRoute(callsign);
    if (!result) return res.status(404).json({ callsign, error: 'not found' });
    res.json({ callsign, ...result });
  } catch (e) {
    res.status(500).json({ callsign, error: e.message });
  }
});

app.post('/api/adsb/route/:callsign/refresh', async (req, res) => {
  const callsign = (req.params.callsign || '').trim().toUpperCase();
  const hex = (req.query.hex || '').trim().toLowerCase();
  try {
    const { deleteCachedRoute, upsertCachedRoute } = require('./src/db/routes');
    deleteCachedRoute(callsign);

    let route = null;

    // 1. If hex is provided, try to resolve the actual live flight route from OpenSky transponder data
    if (hex && /^[0-9a-f]{6}$/.test(hex)) {
      try {
        const flightInfo = await openSkyFlight(hex, Date.now());
        if (flightInfo && flightInfo.origin && flightInfo.destination) {
          route = {
            origin: flightInfo.origin,
            destination: flightInfo.destination,
            airline_name: callsign.slice(0, 3),
            source: 'opensky-live'
          };
          upsertCachedRoute({ callsign, ...route });
        }
      } catch (err) {
        console.warn(`[refresh] OpenSky live lookup failed for ${callsign} (${hex}):`, err.message);
      }
    }

    // 2. Fallback to normal resolution (routeset, adsbdb, aeroapi)
    if (!route) {
      route = await resolveRoute(callsign);
    }

    // Clear the aboveCache to force a fresh data load on the next client poll
    _aboveCache = null;

    res.json({ success: true, route });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/api/adsb/route',     rateLimit({ windowMs: 60_000, max: 60 }));
app.get('/api/adsb/route-historical', async (req, res) => {
  const cs = (req.query.callsign || '').trim().toUpperCase();
  const ts = parseInt(req.query.ts || '0', 10);
  if (!cs || !ts) return res.status(400).json({ error: 'callsign and ts required' });

  // Determine ICAO24 hex from callsign
  let icao24 = null;
  if (/^[0-9A-F]{6}$/i.test(cs)) {
    icao24 = cs.toLowerCase(); // already a hex address
  } else if (/^N\d{1,5}[A-Z]{0,2}$/i.test(cs)) {
    icao24 = nNumberToIcao24(cs); // US N-number
  }

  if (!icao24) return res.status(404).json({ callsign: cs, error: 'cannot resolve to ICAO24' });

  try {
    const result = await resolveHistoricalRoute(icao24, ts);
    if (!result) return res.status(404).json({ callsign: cs, icao24, error: 'no historical flight found' });
    res.json({ callsign: cs, icao24, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/adsb/above — nearest aircraft with route + photo + progress ──
function _kmBetween(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v == null)) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let _aboveCache = null, _aboveCacheTs = 0;
const _activeRouteRefreshes = new Set();
const _attemptedRouteRefreshes = new Set();

function triggerBackgroundRouteRefresh(callsign, hex) {
  const key = `${callsign}-${hex}`;
  if (_activeRouteRefreshes.has(key)) return;
  _activeRouteRefreshes.add(key);
  _attemptedRouteRefreshes.add(callsign);

  (async () => {
    try {
      const { deleteCachedRoute, upsertCachedRoute } = require('./src/db/routes');
      deleteCachedRoute(callsign);

      let route = null;
      if (hex && /^[0-9a-f]{6}$/.test(hex)) {
        const flightInfo = await openSkyFlight(hex, Date.now());
        if (flightInfo && flightInfo.origin && flightInfo.destination) {
          route = {
            origin: flightInfo.origin,
            destination: flightInfo.destination,
            airline_name: callsign.slice(0, 3),
            source: 'opensky-live'
          };
          upsertCachedRoute({ callsign, ...route });
          console.log(`[route] Auto-refreshed route in background for ${callsign} (${hex}): ${route.origin}-${route.destination}`);
        }
      }

      if (!route) {
        await resolveRoute(callsign);
      }

      _aboveCache = null; // Bust cache to force client refresh
    } catch (err) {
      console.error(`[route] Background auto-refresh failed for ${callsign}:`, err.message);
    } finally {
      _activeRouteRefreshes.delete(key);
    }
  })();
}

app.get('/api/adsb/above', async (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n) || getSetting('above_count'), 20);
    const radiusNm = getSetting('above_radius_nm');
    const now = Date.now();
    if (_aboveCache && now - _aboveCacheTs < 8_000 && _aboveCache._n >= n) {
      return res.json({ ..._aboveCache, aircraft: _aboveCache.aircraft.slice(0, n) });
    }

    const r = await fetch(`http://127.0.0.1:${PORT}/api/adsb/aircraft`);
    if (!r.ok) return res.status(502).json({ error: 'aircraft feed unavailable' });
    const data = await r.json();
    const list = data.aircraft || [];

    // Only aircraft genuinely overhead count: within above_radius_nm (0 = no cap).
    const nearest = list
      .filter(ac => ac.lat != null && ac.lon != null && ac.dist_nm != null &&
                    (radiusNm <= 0 || ac.dist_nm <= radiusNm))
      .sort((a, b) => a.dist_nm - b.dist_nm)
      .slice(0, 20);

    const out = nearest.map(ac => {
      const cs   = (ac.flight || '').trim().toUpperCase();
      let route = cs ? getCachedRoute(cs) : null;
      const reg   = /^[0-9a-f]{6}$/i.test(ac.hex || '') ? getCachedRegistration(ac.hex) : null;

      // Auto-resolve missing or null-cached routes in the background exactly once
      if (cs && (!route || !route.origin)) {
        if (!_attemptedRouteRefreshes.has(cs)) {
          triggerBackgroundRouteRefresh(cs, ac.hex);
        }
      }

      // Detour check: if the plane is active, verify the cached route is plausible
      if (route && route.origin && route.origin_lat != null && route.dest_lat != null && ac.lat != null && ac.lon != null) {
        const flown = _kmBetween(route.origin_lat, route.origin_lon, ac.lat, ac.lon);
        const remaining = _kmBetween(ac.lat, ac.lon, route.dest_lat, route.dest_lon);
        const total = route.route_km || (flown + remaining);
        const detour = (flown + remaining) - total;
        const maxDetour = getSetting('route_max_detour_km') || 450;

        if (detour > maxDetour) {
          console.log(`[route] Cached route ${route.origin}-${route.destination} for ${cs} is implausible (detour: ${Math.round(detour)}km > ${maxDetour}km). Discarding and refreshing.`);
          route = null;
          triggerBackgroundRouteRefresh(cs, ac.hex);
        }
      }

      let progress = null, dest_dist_km = null;
      if (route?.origin && route?.origin_lat != null && route?.dest_lat != null) {
        const flown  = _kmBetween(route.origin_lat, route.origin_lon, ac.lat, ac.lon);
        dest_dist_km = _kmBetween(ac.lat, ac.lon, route.dest_lat, route.dest_lon);
        const total  = route.route_km || ((flown ?? 0) + (dest_dist_km ?? 0));
        if (total > 0 && flown != null) progress = Math.max(0, Math.min(100, Math.round((flown / total) * 100)));
      }

      return {
        hex:      ac.hex,
        flight:   (ac.flight || '').trim() || null,
        dist_nm:  ac.dist_nm,
        alt_baro: ac.alt_baro ?? ac.ft_baro ?? null,
        gs:       ac.gs ?? null,
        track:    ac.track ?? null,
        lat:      ac.lat,
        lon:      ac.lon,
        registration: reg?.registration || null,
        type:         reg?.type || ac.desc || ac.t || null,
        manufacturer: reg?.manufacturer || null,
        photo_thumb:  reg?.photo_thumb || null,
        photo_url:    reg?.photo_url || null,
        origin:              route?.origin || null,
        destination:         route?.destination || null,
        origin_name:         route?.origin_name || null,
        destination_name:    route?.destination_name || null,
        origin_country:      route?.origin_country || null,
        destination_country: route?.destination_country || null,
        route_km:            route?.route_km || null,
        dest_dist_km:        dest_dist_km != null ? Math.round(dest_dist_km) : null,
        progress,
      };
    });

    const result = { updated_at: new Date().toISOString(), station: data.station, _n: 20, aircraft: out };
    _aboveCache = result; _aboveCacheTs = now;
    res.json({ ...result, aircraft: out.slice(0, n) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/adsb/paths — overhead aircraft with their ACTUAL flown track ──
// For each in-scope aircraft: current position, resolved route O/D coords, and
// the real wide-area track (ADSBEx → OpenSky). The map draws the flown track plus
// a dashed great-circle on to the destination. Scope + count come from settings.
let _pathsCache = null, _pathsCacheTs = 0;

// Run async tasks with bounded concurrency (keep trace-API load gentle).
async function _mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

app.use('/api/adsb/paths', rateLimit({ windowMs: 60_000, max: 30 }));
app.get('/api/adsb/paths', async (req, res) => {
  try {
    const now = Date.now();
    if (_pathsCache && now - _pathsCacheTs < 20_000) return res.json(_pathsCache);

    const scope    = getSetting('paths_scope');               // 'overhead' | 'all'
    const maxAc    = getSetting('paths_max_aircraft');
    const radiusNm = getSetting('above_radius_nm');

    const r = await fetch(`http://127.0.0.1:${PORT}/api/adsb/aircraft`);
    if (!r.ok) return res.status(502).json({ error: 'aircraft feed unavailable' });
    const data = await r.json();

    const inScope = (data.aircraft || [])
      .filter(ac => ac.lat != null && ac.lon != null && ac.dist_nm != null &&
                    (scope === 'all' || radiusNm <= 0 || ac.dist_nm <= radiusNm))
      .sort((a, b) => a.dist_nm - b.dist_nm)
      .slice(0, maxAc);

    const aircraft = (await _mapLimited(inScope, 5, async (ac) => {
      const cs    = (ac.flight || '').trim().toUpperCase();
      const route = cs ? getCachedRoute(cs) : null;
      const track = await resolveTrack(ac.hex);
      if (!track) return null;   // no real track → nothing to draw
      return {
        hex: ac.hex, flight: cs || null, lat: ac.lat, lon: ac.lon,
        dist_nm: ac.dist_nm, alt_baro: ac.alt_baro ?? ac.ft_baro ?? null,
        track_source: track.source,
        // current leg, anchored to the live position so it ends where the plane is now
        track: [...track.points.map(p => p ? [p.lat, p.lon] : null), [ac.lat, ac.lon]],
        origin: route?.origin || null, destination: route?.destination || null,
        origin_lat: route?.origin_lat ?? null, origin_lon: route?.origin_lon ?? null,
        dest_lat: route?.dest_lat ?? null, dest_lon: route?.dest_lon ?? null,
      };
    })).filter(Boolean);

    const result = { updated_at: new Date().toISOString(), station: data.station, scope, count: aircraft.length, aircraft };
    _pathsCache = result; _pathsCacheTs = now;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Path-heat accumulator ──────────────────────────────────────
// Builds a rolling, tar1090-style heatmap persisted to disk (pathheat.db): keep
// the full flown leg of every aircraft seen overhead within the last
// `pathheat_window_hours`, keyed by hex, so the heat layer fills in over the
// whole window and survives restarts.
const PATHHEAT_REFETCH_MS = 1_800_000;   // refetch a hex's leg at most every 30 min
const PATHHEAT_MAX_POINTS  = 60_000;     // cap points sent to the heat layer
let _accumStation = null;

// Decimate to `max`, preserving null gap-markers (decimate per segment).
function _decimatePts(pts, max) {
  if (pts.some(p => p === null)) {
    const segs = []; let cur = [];
    for (const p of pts) { if (p === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
    if (cur.length) segs.push(cur);
    const total = segs.reduce((n, s) => n + s.length, 0) || 1;
    const out = [];
    segs.forEach((s, i) => { if (i) out.push(null); out.push(..._decimatePts(s, Math.max(2, Math.round(max * s.length / total)))); });
    return out;
  }
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

// Like tar1090's Tracks: capture every aircraft the receiver currently sees
// (scope=all) or just those overhead (scope=overhead), keep their full flown
// leg, and accumulate over the window. Already-known aircraft are refreshed for
// free; only up to `paths_max_aircraft` NEW traces are fetched per cycle so the
// (undocumented) ADSBEx endpoint isn't hammered — the rest are picked up over
// subsequent cycles.
async function runPathAccum() {
  try {
    const scope    = getSetting('paths_scope');
    const budget   = getSetting('paths_max_aircraft');
    const radiusNm = getSetting('above_radius_nm');
    const windowMs = getSetting('pathheat_window_hours') * 3_600_000;
    const now = Date.now();

    const r = await fetch(`http://127.0.0.1:${PORT}/api/adsb/aircraft`);
    if (r.ok) {
      const data = await r.json();
      if (data.station) _accumStation = data.station;
      const inScope = (data.aircraft || [])
        .filter(ac => /^[0-9a-f]{6}$/i.test(ac.hex || '') && ac.lat != null && ac.lon != null && ac.dist_nm != null &&
                      (scope === 'all' || radiusNm <= 0 || ac.dist_nm <= radiusNm))
        .sort((a, b) => a.dist_nm - b.dist_nm);

      // Refresh lifetime of every known leg (free); collect the unknown ones to fetch.
      const toFetch = [];
      for (const ac of inScope) {
        const meta = getLegMeta(ac.hex);
        if (meta && now - meta.fetched_at < PATHHEAT_REFETCH_MS) touchLeg(ac.hex, now);
        else toFetch.push(ac);
      }
      await _mapLimited(toFetch.slice(0, budget), 5, async (ac) => {
        const track = await resolveTrack(ac.hex);
        if (track && track.points.length > 1) {
          upsertLeg(ac.hex, _decimatePts(track.points.map(p => p ? [p.lat, p.lon] : null), 150), now);
        }
      });
    }
    pruneLegs(now - windowMs);
  } catch { /* silent */ }
}

app.use('/api/adsb/pathheat', rateLimit({ windowMs: 60_000, max: 30 }));
app.get('/api/adsb/pathheat', (req, res) => {
  const since = Date.now() - getSetting('pathheat_window_hours') * 3_600_000;
  res.json({
    updated_at: new Date().toISOString(),
    station: _accumStation,
    window_hours: getSetting('pathheat_window_hours'),
    aircraft_count: legCount(since),
    points: _decimatePts(allPoints(since), PATHHEAT_MAX_POINTS),
  });
});

// Lines version of the same accumulated data (mirrors tar1090's Tracks map):
// every aircraft seen within the window, each as a flown trail with null gap-breaks.
app.use('/api/adsb/pathlines', rateLimit({ windowMs: 60_000, max: 30 }));
app.get('/api/adsb/pathlines', (req, res) => {
  const since = Date.now() - getSetting('pathheat_window_hours') * 3_600_000;
  res.json({
    updated_at: new Date().toISOString(),
    station: _accumStation,
    window_hours: getSetting('pathheat_window_hours'),
    aircraft_count: legCount(since),
    legs: allLegs(since, 150),
  });
});

app.use('/api/adsb/registration', rateLimit({ windowMs: 60_000, max: 120 }));
app.get('/api/adsb/registration/:hex', async (req, res) => {
  const hex = (req.params.hex || '').trim().toLowerCase();
  try {
    const result = await resolveRegistration(hex);
    if (!result) return res.status(404).json({ hex, error: 'not found' });
    res.json({ hex, ...result });
  } catch (e) {
    res.status(500).json({ hex, error: e.message });
  }
});

app.use('/api/adsb', adsbRouter);

// ── Stats API ────────────────────────────────────────────────────

// Simple 30s in-memory cache for /api/stats/live
let _liveCache = null, _liveCacheTs = 0;

app.get('/api/stats/live', (req, res) => {
  try {
    const now = Date.now();
    if (_liveCache && now - _liveCacheTs < 30_000) return res.json(_liveCache);
    const snaps = getRecentSnapshots(1);
    if (!snaps.length) {
      const result = { snapshot: null, records: getRecords() };
      _liveCache = result; _liveCacheTs = now;
      return res.json(result);
    }
    const last     = snaps[snaps.length - 1];
    const aircraft = JSON.parse(last.aircraft_json);
    const snapshot = processSnapshot(aircraft);
    const result   = { snapshot, records: getRecords() };
    _liveCache = result; _liveCacheTs = now;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/daily', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    res.json(getDailyStats(days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/monthly', (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 24, 120);
    res.json(getMonthlyStats(months));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/yearly', (req, res) => {
  try { res.json(getYearlyStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/leaderboard', (req, res) => {
  try { res.json(getWatchlistLeaderboard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats/feeders-history', (req, res) => {
  try { res.json(getFeederHistory(24)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Period records helpers ────────────────────────────────────────

// Map the few reliable scalar columns of a legacy daily row (days predating the
// full day_records_json) into record entries, so old days still contribute.
function scalarRowToRecords(row) {
  const out = {};
  const add = (key, num, text) => {
    if (num == null) return;
    out[key] = { record_key: key, value_num: num, value_text: text,
      callsign: null, detail: null, achieved_date: row.date };
  };
  add('most_aircraft_at_once', row.max_aircraft, row.max_aircraft != null ? String(row.max_aircraft) : null);
  add('highest_altitude_ft',   row.max_altitude, row.max_altitude != null ? `${Number(row.max_altitude).toLocaleString()} ft` : null);
  add('fastest_speed_kts',     row.max_speed,    row.max_speed != null ? `${row.max_speed} kts` : null);
  if (row.farthest_origin_km != null) add('farthest_origin_km', row.farthest_origin_km, row.farthest_origin || '');
  if (row.farthest_dest_km   != null) add('farthest_dest_km',   row.farthest_dest_km,   row.farthest_dest   || '');
  if (row.longest_flight_nm  != null) add('longest_stage_nm',   row.longest_flight_nm,  `${row.longest_flight_nm} nm`);
  return out;
}

function computePeriodRecords(dailyRows, allTime) {
  const dateSet = new Set(dailyRows.map(r => r.date));
  const today   = new Date().toISOString().slice(0, 10);
  dateSet.add(today);

  // Merge: each day's stored full record set, a scalar backstop for legacy days,
  // and the current day computed live from snapshots (it may not be aggregated yet).
  const sets = [];
  for (const row of dailyRows) {
    if (row.day_records_json) { try { sets.push(JSON.parse(row.day_records_json)); } catch {} }
    sets.push(scalarRowToRecords(row));
  }
  sets.push(computeRecordsForSnapshots(getTodaySnapshots(), today));

  const result = mergeRecordSets(sets);

  // For any record still missing, fall back to the all-time record if it was
  // achieved within this period (covers older days with no per-day detail).
  for (const key of Object.keys(allTime)) {
    const atRec = allTime[key];
    if (!result[key] && atRec?.achieved_date && dateSet.has(atRec.achieved_date)) result[key] = atRec;
  }
  return result;
}

function computeTodayRecords(snaps, allTime) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const live = computeRecordsForSnapshots(snaps, todayStr);

  // Prefer the all-time entry when it was set today (it carries verified detail
  // such as a routeset-enriched callsign); otherwise use the live computation.
  const result = {};
  for (const key of new Set([...Object.keys(live), ...Object.keys(allTime)])) {
    const atRec = allTime[key];
    result[key] = (atRec?.achieved_date === todayStr) ? atRec : (live[key] || null);
  }
  return result;
}

let _recPeriodCache = {}, _recPeriodCacheTs = {};

app.get('/api/stats/records', (req, res) => {
  const period = req.query.period || 'all';
  try {
    const now = Date.now();
    const ttl = period === 'today' ? 60_000 : 300_000;
    if (_recPeriodCache[period] && now - (_recPeriodCacheTs[period] || 0) < ttl) {
      return res.json(_recPeriodCache[period]);
    }
    const allTime = getRecords();
    let result;
    if (period === 'all') {
      result = allTime;
    } else if (period === 'today') {
      result = computeTodayRecords(getTodaySnapshots(), allTime);
    } else {
      const days = period === 'week' ? 7 : period === 'month' ? 30 : 365;
      result = computePeriodRecords(getDailyStats(days), allTime);
    }
    _recPeriodCache[period] = result;
    _recPeriodCacheTs[period] = now;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summary cache — 5 min
let _summaryCache = null, _summaryCacheTs = 0;

// Today cache — 60 s
let _todayCache = null, _todayCacheTs = 0;

app.get('/api/stats/summary', (req, res) => {
  try {
    const now = Date.now();
    if (_summaryCache && now - _summaryCacheTs < 300_000) return res.json(_summaryCache);

    const todayStr     = new Date().toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);
    const monthStr     = todayStr.slice(0, 7);
    const yearStr      = todayStr.slice(0, 4);

    const allDaily    = getDailyStats(3650);
    const todayRow    = allDaily.find(d => d.date === todayStr)    || null;
    const yesterdayRow= allDaily.find(d => d.date === yesterdayStr)|| null;

    const monthRows   = allDaily.filter(d => d.date.startsWith(monthStr));
    const yearRows    = allDaily.filter(d => d.date.startsWith(yearStr));

    const agg = rows => rows.length ? {
      max_aircraft: Math.max(...rows.map(d => d.max_aircraft || 0)),
      total_seen:   rows.reduce((s, d) => s + (d.total_seen || 0), 0),
      commercial:   rows.reduce((s, d) => s + (d.commercial_count || 0), 0),
      ga:           rows.reduce((s, d) => s + (d.ga_count || 0), 0),
      military:     rows.reduce((s, d) => s + (d.military_count || 0), 0),
      days:         rows.length,
    } : null;

    // Hourly buckets for today's sparkline
    const todaySnaps = getSnapshotsByDate(todayStr);
    const hourly_buckets = new Array(24).fill(0);
    const airlineCounts = {}, typeCounts = {}, routeCounts = {};
    const seenCallsigns = new Set();

    for (const snap of todaySnaps) {
      let aircraft;
      try { aircraft = JSON.parse(snap.aircraft_json); } catch { continue; }
      const h = new Date(snap.captured_at).getUTCHours();
      if (snap.aircraft_count > hourly_buckets[h]) hourly_buckets[h] = snap.aircraft_count;

      for (const ac of aircraft) {
        const cs = (ac.flight || '').trim();
        if (cs && !seenCallsigns.has(cs)) {
          seenCallsigns.add(cs);
          // airline by IATA prefix
          if (/^[A-Z]{2,3}\d/.test(cs)) {
            const iata = cs.match(/^([A-Z]{2,3})\d/)?.[1];
            if (iata) airlineCounts[iata] = (airlineCounts[iata] || 0) + 1;
          }
          // trust enrichment-validated routes (route_v=2); home-line backstop for legacy
          if (ac.origin && ac.destination && (ac.route_v >= 2 || routeNearHome(ac.origin, ac.destination))) {
            const key = `${ac.origin}→${ac.destination}`;
            routeCounts[key] = (routeCounts[key] || 0) + 1;
          }
        }
        const t = ac.desc || ac.t || null;
        if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
    }

    const top = (obj, n) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>({label:k,count:v}));

    const result = {
      today:      todayRow,
      yesterday:  yesterdayRow,
      this_month: agg(monthRows),
      this_year:  agg(yearRows),
      all_time:   agg(allDaily),
      records:    getRecords(),
      hourly_buckets,
      top_routes:  top(routeCounts, 8),
      top_airlines: top(airlineCounts, 8),
      top_types:   top(typeCounts, 8),
      backfill_info: getBackfillInfo(),
    };
    _summaryCache = result; _summaryCacheTs = now;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Today — live aggregate from snapshots (60s cache)
app.get('/api/stats/today', (req, res) => {
  try {
    const now = Date.now();
    if (_todayCache && now - _todayCacheTs < 60_000) return res.json(_todayCache);

    const todayStr = new Date().toISOString().slice(0, 10);
    const snaps = getTodaySnapshots();

    if (!snaps.length) {
      const result = { date: todayStr, empty: true };
      _todayCache = result; _todayCacheTs = now;
      return res.json(result);
    }

    let max_aircraft = 0;
    let max_altitude = null, max_speed = null;
    const seen_hex = new Set();
    const hour_max = new Array(24).fill(0);
    // Per-hour accumulators so the UI can filter the day panel to a single hour.
    const hours = Array.from({ length: 24 }, () => ({
      commercial: 0, ga: 0, military: 0, unknown: 0, snap_count: 0,
      seen: new Set(), max_altitude: null, max_speed: null, max_aircraft: 0,
    }));
    const type_breakdown = {};
    const route_counts = {};
    const airline_counts = {};
    const country_counts = {};
    const airport_counts = {};   // code → { count, domestic }
    const HOME_COUNTRY = String(getSetting('home_country_iso') || 'US').toUpperCase();
    let tot_commercial = 0, tot_ga = 0, tot_military = 0, tot_unknown = 0;
    let snap_count = 0;

    for (const snap of snaps) {
      let aircraft;
      try { aircraft = JSON.parse(snap.aircraft_json); } catch { continue; }
      snap_count++;

      const h   = new Date(snap.captured_at).getUTCHours();
      const cnt = aircraft.length;
      if (cnt > max_aircraft)  max_aircraft = cnt;
      if (cnt > hour_max[h])   hour_max[h]  = cnt;

      const proc = processSnapshot(aircraft);
      tot_commercial += proc.commercial;
      tot_ga         += proc.ga;
      tot_military   += proc.military;
      tot_unknown    += proc.unknown;

      const H = hours[h];
      H.snap_count++;
      H.commercial += proc.commercial;
      H.ga         += proc.ga;
      H.military   += proc.military;
      H.unknown    += proc.unknown;
      if (cnt > H.max_aircraft) H.max_aircraft = cnt;

      for (const ac of aircraft) {
        seen_hex.add(ac.hex);
        H.seen.add(ac.hex);

        const alt = ac.alt_baro ?? ac.ft_baro ?? null;
        if (alt != null && (max_altitude == null || alt > max_altitude)) max_altitude = alt;
        if (alt != null && (H.max_altitude == null || alt > H.max_altitude)) H.max_altitude = alt;

        const spd = ac.gs ?? null;
        if (spd != null && (max_speed == null || spd > max_speed)) max_speed = Math.round(spd);
        if (spd != null && (H.max_speed == null || spd > H.max_speed)) H.max_speed = Math.round(spd);

        const type = ac.desc || ac.t || null;
        if (type) type_breakdown[type] = (type_breakdown[type] || 0) + 1;

        const cs = (ac.flight || '').trim();
        if (cs && /^[A-Z]{2,3}\d/.test(cs)) {
          const iata = cs.match(/^([A-Z]{2,3})\d/)?.[1];
          if (iata) airline_counts[iata] = (airline_counts[iata] || 0) + 1;
        }

        // Trust routes validated at enrichment (route_v=2, incl. diversions);
        // apply the home-line backstop only to legacy snapshots.
        if (ac.origin && ac.destination && (ac.route_v >= 2 || routeNearHome(ac.origin, ac.destination))) {
          const key = `${ac.origin}→${ac.destination}`;
          route_counts[key] = (route_counts[key] || 0) + 1;
          for (const [code, country] of [[ac.origin, ac.origin_country], [ac.destination, ac.destination_country]]) {
            if (country) country_counts[country] = (country_counts[country] || 0) + 1;
            if (code) {
              const a = airport_counts[code] || (airport_counts[code] = { count: 0, domestic: country ? country === HOME_COUNTRY : null });
              a.count++;
              if (a.domestic == null && country) a.domestic = country === HOME_COUNTRY;
            }
          }
        }
      }
    }

    const peak_hour = hour_max.indexOf(Math.max(...hour_max));
    const top = (obj, n) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>({label:k,count:v}));

    const result = {
      date: todayStr,
      empty: false,
      max_aircraft,
      total_seen:   seen_hex.size,
      peak_hour,
      commercial: snap_count ? Math.round(tot_commercial / snap_count) : 0,
      ga:         snap_count ? Math.round(tot_ga         / snap_count) : 0,
      military:   snap_count ? Math.round(tot_military   / snap_count) : 0,
      unknown:    snap_count ? Math.round(tot_unknown    / snap_count) : 0,
      max_altitude,
      max_speed,
      hours: hours.map(H => ({
        commercial:   H.snap_count ? Math.round(H.commercial / H.snap_count) : 0,
        ga:           H.snap_count ? Math.round(H.ga         / H.snap_count) : 0,
        military:     H.snap_count ? Math.round(H.military   / H.snap_count) : 0,
        unknown:      H.snap_count ? Math.round(H.unknown    / H.snap_count) : 0,
        total_seen:   H.seen.size,
        max_altitude: H.max_altitude,
        max_speed:    H.max_speed,
        max_aircraft: H.max_aircraft,
        snap_count:   H.snap_count,
      })),
      type_breakdown,
      today_routes:   top(route_counts,   10),
      today_airlines: top(airline_counts, 10),
      today_countries: top(country_counts, 10),
      today_airports: Object.entries(airport_counts).sort((a,b)=>b[1].count-a[1].count).slice(0,12)
        .map(([code, v]) => ({ label: code, count: v.count, domestic: v.domestic })),
    };
    _todayCache = result; _todayCacheTs = now;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Interesting aircraft — recent sightings grouped by category
let _interestingCache = null, _interestingCacheTs = 0;
app.get('/api/stats/interesting', (req, res) => {
  try {
    const now = Date.now();
    if (_interestingCache && now - _interestingCacheTs < 30_000) return res.json(_interestingCache);

    const sightings = getRecentSightings(120);
    const groups = { military: [], government: [], police: [], civilian: [], other: [] };
    for (const s of sightings) {
      const cat = groups[s.category] ? s.category : 'other';
      groups[cat].push(s);
    }
    const result = { db_size: interestingCount(), total_recent: sightings.length, groups };
    _interestingCache = result; _interestingCacheTs = now;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reaggregate a specific date from snapshots (admin, curl-only)
app.post('/admin/stats/reaggregate', (req, res) => {
  try {
    const date = (req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'date param required (YYYY-MM-DD)' });
    }
    aggregateDay(date);
    const stats = getDayStats(date);
    res.json({ success: true, date, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Settings (admin) ─────────────────────────────────────────────
// Page + JSON data + update, all behind the /admin token gate.
app.get('/admin/settings', (req, res) => {
  // Never cache the settings UI — a stale copy hides newly-added settings.
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'src', 'views', 'settings.html'));
});
app.get('/admin/settings/data', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Redacted values: secret fields come back as "set"/"not set", never the value.
  res.json({ schema: getSchema(), values: getRedactedSettings(), diag: { track: getTrackStats() }, version: APP_VERSION });
});
app.post('/admin/settings', express.json(), (req, res) => {
  try {
    const { applied, requiresRestart } = updateSettings(req.body || {});
    // Bust caches whose output depends on the changed knobs.
    _aboveCache = null; _todayCache = null; _summaryCache = null; _liveCache = null;
    // Feeder detection settings change which feeders/containers we probe — drop
    // the 30s feeders/docker cache so the change shows immediately.
    if (adsbRouter.bustFeederCache) adsbRouter.bustFeederCache();
    res.json({ success: true, applied, requiresRestart });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Watchlist Manager API ──────────────────────────────────────────
app.get('/admin/watchlist', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    res.json(getWatchlist(page, limit, search));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/watchlist', express.json(), (req, res) => {
  try {
    const ac = req.body || {};
    if (!ac.icao || !/^[0-9a-fA-F]{6}$/.test(ac.icao)) {
      return res.status(400).json({ error: 'Valid 6-character hex ICAO is required' });
    }
    upsertWatchlist(ac);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/watchlist/:icao', (req, res) => {
  try {
    const deleted = deleteWatchlist(req.params.icao);
    res.json({ success: deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Custom Feeders CRUD API ────────────────────────────────────────
app.get('/admin/feeders', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'src', 'data', 'feeders.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const catalog = JSON.parse(content);
    
    // Map nested 'detect' properties to flat 'source' and 'docker_container' for the UI
    const feedersObj = Object.fromEntries(catalog.map(f => {
      const source = f.detect ? (f.detect.type === 'static' ? 'audit' : (f.detect.type === 'docker' ? 'audit' : f.detect.type)) : 'audit';
      const docker_container = (f.detect && f.detect.type === 'docker') ? f.detect.container : null;
      return [f.key, {
        ...f,
        source,
        docker_container
      }];
    }));
    
    res.json(feedersObj);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/feeders', express.json(), (req, res) => {
  try {
    const feeder = req.body || {};
    if (!feeder.key || !feeder.name) {
      return res.status(400).json({ error: 'Feeder key and name are required' });
    }
    
    const filePath = path.join(__dirname, 'src', 'data', 'feeders.json');
    let catalog = [];
    try {
      catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(catalog)) catalog = [];
    } catch {}
    
    const idx = catalog.findIndex(f => f.key === feeder.key);
    
    // Build detect block based on source
    let detect = null;
    if (feeder.source === 'ultrafeeder') {
      detect = { type: 'ultrafeeder' };
    } else if (feeder.docker_container) {
      detect = { type: 'docker', container: feeder.docker_container };
    } else if (feeder.source === 'realtime') {
      // Keep existing detect block if it was realtime, or set a default
      const existing = idx >= 0 ? catalog[idx].detect : null;
      detect = existing && existing.type === 'realtime' ? existing : { type: 'realtime', port: 8754, path: '/data/receiver.json' };
    }

    const updatedFeeder = {
      key: feeder.key,
      name: feeder.name,
      initials: feeder.initials || feeder.name.slice(0, 2).toUpperCase(),
      color: feeder.color || '#3b82f6',
      source: feeder.source || 'audit',
      public_url: feeder.public_url || '',
      detail_url: feeder.detail_url || '',
      mlat: !!feeder.mlat,
      detect: detect,
      installed: feeder.installed !== false
    };
    
    if (idx >= 0) {
      catalog[idx] = updatedFeeder;
    } else {
      catalog.push(updatedFeeder);
    }
    
    fs.writeFileSync(filePath, JSON.stringify(catalog, null, 2));
    if (adsbRouter.bustFeederCache) adsbRouter.bustFeederCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/feeders/:key', (req, res) => {
  try {
    const key = req.params.key;
    const filePath = path.join(__dirname, 'src', 'data', 'feeders.json');
    let catalog = [];
    try {
      catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(catalog)) catalog = [];
    } catch {}
    
    const filtered = catalog.filter(f => f.key !== key);
    if (filtered.length !== catalog.length) {
      fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
      if (adsbRouter.bustFeederCache) adsbRouter.bustFeederCache();
      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'Feeder not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Branding (configurable; generic defaults so forks stay unbranded) ──
const BRAND_NAME   = process.env.BRAND_NAME   || 'radar';
const BRAND_DOMAIN = process.env.BRAND_DOMAIN || '';            // e.g. "example.com"; empty = name only
const PARENT_URL   = process.env.PARENT_LINK_URL   || '';        // e.g. "https://example.com"; empty = hide link
const PARENT_LABEL = process.env.PARENT_LINK_LABEL || '← Home';

const BRAND_TITLE  = BRAND_DOMAIN ? `${BRAND_NAME} · ${BRAND_DOMAIN}` : BRAND_NAME;
const BRAND_HOST   = BRAND_DOMAIN ? `${BRAND_NAME}.${BRAND_DOMAIN}` : BRAND_NAME;
const BRAND_HEADER = BRAND_DOMAIN
  ? `<span id="brand-radar">${BRAND_NAME}</span><span id="brand-sep">/</span><span id="brand-domain">${BRAND_DOMAIN}</span>`
  : `<span id="brand-radar">${BRAND_NAME}</span>`;
const PARENT_LINK = PARENT_URL
  ? `<a class="hide-narrow" href="${PARENT_URL}" target="_blank" style="font-size:12px;color:var(--muted);text-decoration:none" onmouseover="this.style.color='var(--blue-lt)'" onmouseout="this.style.color='var(--muted)'">${PARENT_LABEL}</a>
    <span class="hide-narrow" style="color:var(--border);font-size:12px">|</span>`
  : '';
const PARENT_LINK_FEEDER = PARENT_URL
  ? `<a class="back-link hide-narrow" href="${PARENT_URL}" target="_blank">${PARENT_LABEL}</a>`
  : '';

const APP_VERSION = require('./package.json').version;

const BRAND_TOKENS = {
  '{{BRAND_TITLE}}':  BRAND_TITLE,
  '{{BRAND_NAME}}':   BRAND_NAME,
  '{{BRAND_HOST}}':   BRAND_HOST,
  '{{BRAND_HEADER}}': BRAND_HEADER,
  '{{PARENT_LINK}}':  PARENT_LINK,
  '{{PARENT_LINK_FEEDER}}': PARENT_LINK_FEEDER,
  '{{VERSION}}':      APP_VERSION,
  '{{GRAFANA_URL}}':    process.env.GRAFANA_URL || '#',
  '{{PROMETHEUS_URL}}':  process.env.PROMETHEUS_URL || '#',
  '{{INFLUXDB_URL}}':    process.env.INFLUXDB_URL || '#',
};

const _htmlCache = new Map();
function sendBranded(res, relPath, type = 'html') {
  let html = _htmlCache.get(relPath);
  if (html === undefined) {
    html = fs.readFileSync(path.join(__dirname, 'public', relPath), 'utf8');
    for (const [tok, val] of Object.entries(BRAND_TOKENS)) html = html.split(tok).join(val);
    _htmlCache.set(relPath, html);
  }
  res.type(type).send(html);
}

// Branded HTML routes must precede express.static so token substitution always runs.
app.get(['/', '/index.html'], (req, res) => sendBranded(res, 'index.html'));
app.get(['/links', '/links.html'], (req, res) => sendBranded(res, 'links.html'));
app.get(['/feeder', '/feeder/', '/feeder/index.html'], (req, res) => sendBranded(res, 'feeder/index.html'));
app.get('/feeder/fr24.html', (req, res) => sendBranded(res, 'feeder/fr24.html'));
app.get('/feeder/piaware.html', (req, res) => sendBranded(res, 'feeder/piaware.html'));

// PWA manifest carries brand tokens (name/short_name) → branded route before static.
app.get('/manifest.webmanifest', (req, res) =>
  sendBranded(res, 'manifest.webmanifest', 'application/manifest+json'));

app.use(express.static(path.join(__dirname, 'public')));

// ── Optional direct HTTPS listener (opt-in) ──────────────────────────
// A PWA only installs from a secure context (HTTPS or localhost). With no
// domain / reverse proxy, point HTTPS_CERT + HTTPS_KEY at a mounted cert and
// this serves the app over TLS directly so phones on the LAN can install it.
// Use a cert your devices TRUST (mkcert, Let's Encrypt, `tailscale cert`) —
// a bare self-signed cert triggers a browser warning, which still blocks the
// service worker. The plain HTTP listener stays up for loopback health checks
// and reverse-proxy / `tailscale serve` setups that terminate TLS in front.
const HTTPS_CERT = process.env.HTTPS_CERT;
const HTTPS_KEY  = process.env.HTTPS_KEY;
if (HTTPS_CERT && HTTPS_KEY) {
  try {
    const https = require('https');
    const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
    https.createServer(
      { cert: fs.readFileSync(HTTPS_CERT), key: fs.readFileSync(HTTPS_KEY) },
      app,
    ).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[server] radar-dash HTTPS (PWA-ready) at https://0.0.0.0:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.error(`[server] HTTPS listener disabled — could not load cert/key: ${e.message}`);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] radar-dash running at http://0.0.0.0:${PORT}`);

  // Warm the update check once on boot (best-effort; getUpdateStatus re-checks on its interval).
  refreshUpdateCheck().then((s) => {
    if (s && s.updateAvailable) console.log(`[update] newer version available: ${s.latest} (running ${s.current})`);
  }).catch(() => {});

  // ── Snapshot cron ──────────────────────────────────────────────
  let snapshotCycle = 0;

  async function runSnapshot() {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/adsb/aircraft`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const data     = await r.json();
      const aircraft = Array.isArray(data) ? data : (data.aircraft || []);
      const count    = data.count ?? aircraft.length;

      // Enrich every aircraft with route data before storing (local cache →
      // one batched routeset call for the remaining misses).
      await enrichSnapshotRoutes(aircraft);
      await enrichSnapshotRegistrations(aircraft);

      const snap = processSnapshot(aircraft);
      insertSnapshot(count, aircraft);
      await checkAndUpdateRecords(snap, aircraft);
      snapshotCycle++;
      if (snapshotCycle % 10 === 0) pruneSnapshots();
      // Bust caches so next request recomputes
      _summaryCache    = null;
      _liveCache       = null;
      _todayCache      = null;
      _recPeriodCache  = {};
      _recPeriodCacheTs = {};
    } catch { /* silent */ }
  }

  // ── Interesting-aircraft fast poll ─────────────────────────────
  // Mirrors skystats: the watchlist matcher runs continuously (default 10s)
  // instead of once per 60s snapshot, so brief/transient flagged aircraft
  // that blink in and out between snapshots get caught. Lightweight — only
  // matches against the local plane-alert DB; recordSighting() de-dupes per
  // hex/hour so the faster cadence doesn't flood interesting_seen.
  const INTERESTING_POLL_MS = getSetting('interesting_poll_ms');
  async function runInterestingPoll() {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/adsb/aircraft`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const data     = await r.json();
      const aircraft = Array.isArray(data) ? data : (data.aircraft || []);
      flagInterestingAircraft(aircraft);
    } catch { /* silent */ }
  }

  // ── Midnight daily aggregation ─────────────────────────────────
  let _lastMidnightDate = null;
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 1) {
      const today = now.toISOString().slice(0, 10);
      if (_lastMidnightDate !== today) {
        _lastMidnightDate = today;
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        try { aggregateDay(yesterday); } catch (e) { console.error('[cron] aggregateDay failed:', e.message); }
        loadPlaneAlertDb().catch(e => console.error('[cron] plane-alert reload failed:', e.message));
        try { pruneSightings(90); } catch (e) { console.error('[cron] pruneSightings failed:', e.message); }
      }
    }
  }, 60_000);

  // ── Backfill + start snapshot cron after 10s ───────────────────
  setTimeout(async () => {
    await checkBackfillAvailability();
    backfillFromRRD().catch(e => console.error('[cron] backfill error:', e.message));
    loadPlaneAlertDb().catch(e => console.error('[startup] plane-alert load failed:', e.message));
    runSnapshot();
    setInterval(runSnapshot, 60_000);
    console.log('[stats] snapshot cron started (60s interval)');
    runInterestingPoll();
    setInterval(runInterestingPoll, INTERESTING_POLL_MS);
    console.log(`[stats] interesting-aircraft poll started (${INTERESTING_POLL_MS / 1000}s interval)`);
    runPathAccum();
    setInterval(runPathAccum, 120_000);
    console.log('[stats] path-heat accumulator started (120s interval)');

    // Periodic feeder logging (every 10 minutes)
    async function logFeederUptime() {
      try {
        const data = await adsbRouter.getFeeders();
        if (data && data.feeders) {
          for (const [key, f] of Object.entries(data.feeders)) {
            if (f.installed) {
              const msgCount = f.messages || (data.fr24 && key === 'fr24' && data.fr24.messages_sent) || null;
              logFeederStatus(key, f.status, msgCount);
            }
          }
        }
      } catch (e) { console.error('[cron] logFeederUptime failed:', e.message); }
    }
    logFeederUptime();
    setInterval(logFeederUptime, 600_000);
    console.log('[stats] feeder-history logging started (10m interval)');
  }, 10_000);
});
