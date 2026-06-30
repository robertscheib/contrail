require('dotenv').config({ path: process.env.SECRETS_PATH || `${process.env.HOME}/projects/secrets.env` });

const express  = require('express');
const fetch    = require('node-fetch');

const { getCatalog, dockerFeeders } = require('./src/data/feeders');
const dockerInspect = require('./src/lib/docker-inspect');
const { getSetting } = require('./src/db/settings');

const router = express.Router();

const ADSB_HOST = process.env.ADSB_HOST || '127.0.0.1';
const ADSB_PORT = process.env.ADSB_PORT || '8080';
const BASE      = `http://${ADSB_HOST}:${ADSB_PORT}`;

let station = {
  lat:    parseFloat(process.env.ADSB_STATION_LAT)    || null,
  lon:    parseFloat(process.env.ADSB_STATION_LON)    || null,
  alt_ft: parseFloat(process.env.ADSB_STATION_ALT_FT) || 0,
};

// Auto-populate station coords from receiver.json on startup
(async () => {
  if (!station.lat || !station.lon) {
    try {
      const r = await fetch(`${BASE}/data/receiver.json`, { timeout: 5000 });
      const d = await r.json();
      if (d.lat) {
        station.lat = d.lat;
        station.lon = d.lon;
        console.log(`[adsb] station from receiver.json: ${station.lat}, ${station.lon}`);
      }
    } catch (e) {
      console.warn('[adsb] receiver.json unavailable on startup:', e.message);
    }
  }
})();

function haversineNm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Simple in-memory cache
const _cache = {};
function withCache(key, ttlMs, fn) {
  return async () => {
    const now = Date.now();
    if (_cache[key] && now - _cache[key].ts < ttlMs) return _cache[key].data;
    const data = await fn();
    _cache[key] = { ts: now, data };
    return data;
  };
}

async function safeFetch(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ── /api/adsb/aircraft ────────────────────────────────────────────
const getAircraft = withCache('aircraft', 8000, async () => {
  const data = await safeFetch(`${BASE}/data/aircraft.json`);
  const aircraft = (data.aircraft || []).map(ac => ({
    ...ac,
    dist_nm: ac.lat != null && ac.lon != null
      ? Math.round(haversineNm(station.lat, station.lon, ac.lat, ac.lon) * 10) / 10
      : null,
    age_s: ac.seen != null ? Math.ceil(ac.seen) : null,
  }));
  return {
    updated_at: new Date().toISOString(),
    station: { lat: station.lat, lon: station.lon, alt_ft: station.alt_ft },
    count: aircraft.length,
    aircraft,
  };
});

// ── /api/adsb/live ────────────────────────────────────────────────
const getLive = withCache('live', 25000, async () => {
  const [acData, statsData] = await Promise.all([
    safeFetch(`${BASE}/data/aircraft.json`),
    safeFetch(`${BASE}/data/stats.json`),
  ]);

  const aircraft = (acData.aircraft || []).map(ac => ({
    ...ac,
    dist_nm: ac.lat != null && ac.lon != null
      ? haversineNm(station.lat, station.lon, ac.lat, ac.lon)
      : null,
    age_s: ac.seen != null ? Math.ceil(ac.seen) : null,
  }));

  const fresh    = aircraft.filter(a => a.age_s != null && a.age_s < 60);
  const withPos  = aircraft.filter(a => a.lat != null && a.lon != null);
  const maxRange = withPos.reduce((m, a) => Math.max(m, a.dist_nm || 0), 0);

  // accepted is an array [df17_18, other]; sum for total rate
  const accepted1min = statsData.last1min?.local?.accepted || [0, 0];
  const totalAccepted = (accepted1min[0] || 0) + (accepted1min[1] || 0);
  const msgRate = Math.round((totalAccepted / 60) * 10) / 10;

  const signal = statsData.last1min?.local?.signal ?? null;
  const noise = statsData.last1min?.local?.noise ?? null;
  const peakSignal = statsData.last1min?.local?.peak_signal ?? null;

  // Optional feeder statuses — fetched in parallel, graceful failure
  const [fr24Res, piawareRes] = await Promise.allSettled([
    safeFetch(`http://${ADSB_HOST}:8754/monitor.json`, 2000),
    safeFetch(`http://${ADSB_HOST}:8081/status.json`,  2000),
  ]);
  const fr24    = fr24Res.status    === 'fulfilled' ? fr24Res.value    : null;
  const piaware = piawareRes.status === 'fulfilled' ? piawareRes.value : null;

  const piawareConnected = piaware?.adept?.status === 'green' || piaware?.piaware?.status === 'green';

  function mlatStatus(s) {
    if (s === 'green') return 'synchronized';
    if (s === 'amber') return 'unstable';
    return 'not connected';
  }

  return {
    aircraft_now:       fresh.length,
    aircraft_with_pos:  withPos.length,
    max_range_nm:       Math.round(maxRange * 10) / 10,
    msg_rate:           msgRate,
    signal,
    noise,
    peak_signal:        peakSignal,
    feeders: {
      fr24: fr24 ? {
        status:          fr24.feed_status || 'unknown',
        aircraft:        parseInt(fr24.feed_num_ac_tracked          || '0', 10),
        aircraft_adsb:   parseInt(fr24.feed_num_ac_adsb_tracked     || '0', 10),
        mlat_aircraft:   parseInt(fr24.feed_num_ac_non_adsb_tracked || '0', 10),
        alias:           fr24.feed_alias     || '',
        version:         fr24.build_version  || '',
        build:           fr24.build_revision || '',
        rx_connected:    fr24.rx_connected   === '1',
        feed_server:     fr24.feed_current_server || '',
        uptime_seconds:  parseInt(fr24.local_tods || '0', 10),
        num_messages:    parseInt(fr24.num_messages || '0', 10),
      } : null,
      piaware: piaware ? {
        status:          piawareConnected ? 'connected' : 'offline',
        mlat_status:     mlatStatus(piaware.mlat?.status),
        mlat_message:    piaware.mlat?.message    || '',
        mlat_ok:         piaware.mlat?.status     === 'green',
        piaware_version: piaware.piaware_version  || '',
        site_url:        piaware.site_url          || '',
        cpu_load:        piaware.cpu_load_percent  ?? null,
        uptime_seconds:  piaware.system_uptime     || 0,
        message:         piaware.adept?.message || piaware.piaware?.message || '',
      } : null,
    },
    updated_at: new Date().toISOString(),
  };
});

// ── /api/adsb/stats ───────────────────────────────────────────────
// stats.json has last1min/last5min/last15min/total — no last1h/last24h
const getStats = withCache('stats', 55000, async () => {
  const data = await safeFetch(`${BASE}/data/stats.json`);

  function bucket(b) {
    if (!b) return { messages: 0, local_accepted: 0, aircraft_with_pos: 0, max_distance_nm: null };
    const accepted = b.local?.accepted || [0, 0];
    const totalAcc = (accepted[0] || 0) + (accepted[1] || 0);
    const maxDist  = b.max_distance ? Math.round(b.max_distance * 0.000539957 * 10) / 10 : null;
    return {
      messages:           b.messages || 0,
      local_accepted:     totalAcc,
      aircraft_with_pos:  b.position_count_total || 0,
      max_distance_nm:    maxDist,
      tracks:             b.tracks?.all || 0,
      start:              b.start,
      end:                b.end,
    };
  }

  const uptimeSecs = Math.round((data.total?.end || 0) - (data.total?.start || 0));
  const totalMessages = data.total?.local?.accepted
    ? (data.total.local.accepted[0] || 0) + (data.total.local.accepted[1] || 0)
    : (data.total?.messages || 0);

  return {
    last_15min:     bucket(data.last15min),
    total:          bucket(data.total),
    uptime_seconds: uptimeSecs,
    msg_rate_total: uptimeSecs > 0 ? Math.round((totalMessages / uptimeSecs) * 10) / 10 : 0,
    updated_at:     new Date().toISOString(),
  };
});

// ── /api/adsb/feeders ─────────────────────────────────────────────
// Data-driven from the feeder catalog (src/data/feeders.json). `installed` and
// live status are COMPUTED at runtime — realtime HTTP probes for fr24/piaware,
// read-only `docker inspect` (local or over SSH) for container-backed feeders,
// and a manual enabled-list for ultrafeeder/static feeders. The dashboard only
// reflects what's running; it never edits the feeder stack.
function parseFr24(f) {
  return {
    status:         f?.feed_status || 'connected',
    aircraft:       parseInt(f?.feed_num_ac_tracked          || '0', 10),
    aircraft_adsb:  parseInt(f?.feed_num_ac_adsb_tracked     || '0', 10),
    mlat_aircraft:  parseInt(f?.feed_num_ac_non_adsb_tracked || '0', 10),
    mlat_status:    'active',
    alias:          f?.feed_alias    || '',
    version:        f?.build_version || '',
    rx_connected:   f?.rx_connected  === '1',
    uptime_seconds: parseInt(f?.local_tods || '0', 10),
  };
}

function parsePiaware(p) {
  const ok = p?.adept?.status === 'green' || p?.piaware?.status === 'green';
  const mlatLabel = s => s === 'green' ? 'synchronized' : s === 'amber' ? 'unstable' : 'not connected';
  return {
    status:          ok ? 'connected' : 'offline',
    mlat_status:     mlatLabel(p?.mlat?.status),
    mlat_message:    p?.mlat?.message    || '',
    piaware_version: p?.piaware_version  || '',
    site_url:        p?.site_url         || '',
    cpu_load:        p?.cpu_load_percent ?? null,
    uptime_seconds:  p?.system_uptime    || 0,
  };
}

// Map a docker container record → feeder status.
function dockerStatus(c) {
  if (!c) return 'not_installed';
  if (c.status !== 'running')   return 'offline';
  if (c.health === 'unhealthy') return 'degraded';
  if (c.health === 'starting')  return 'starting';
  return 'connected';
}

const getFeeders = withCache('feeders', 30000, async () => {
  const catalog = getCatalog();
  const mode = getSetting('feeder_detect_mode');
  const enabled = new Set(
    String(getSetting('feeder_enabled_keys') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );

  // Realtime probes (fr24, piaware) + monitoring services in parallel.
  const rtEntries = catalog.filter(f => f.detect.type === 'realtime');
  const monServices = {
    grafana:    (process.env.GRAFANA_INTERNAL_URL || 'http://localhost:3000') + '/api/health',
    prometheus: (process.env.PROMETHEUS_INTERNAL_URL || 'http://localhost:9090') + '/api/v1/status/buildinfo',
    influxdb:   (process.env.INFLUXDB_INTERNAL_URL || 'http://localhost:8086') + '/health',
  };

  const rtResults = await Promise.allSettled([
    ...rtEntries.map(f => safeFetch(`http://${ADSB_HOST}:${f.detect.port}${f.detect.path}`, 3000)),
    ...Object.values(monServices).map(url => safeFetch(url, 2000))
  ]);

  const rtData = {};
  rtEntries.forEach((f, i) => { rtData[f.key] = rtResults[i].status === 'fulfilled' ? rtResults[i].value : null; });

  const monData = {};
  Object.keys(monServices).forEach((key, i) => {
    const idx = rtEntries.length + i;
    monData[key] = rtResults[idx].status === 'fulfilled' && rtResults[idx].value !== null;
  });

  // One docker round-trip for every container-backed feeder + non-feeder local
  // services (e.g. planefence) the main page links to (skipped when off).
  const SERVICE_CONTAINERS = { planefence: 'planefence' };
  const inspectNames = [...dockerFeeders().map(d => d.container), ...Object.values(SERVICE_CONTAINERS)];
  const dh = (mode === 'local' || mode === 'remote')
    ? await dockerInspect.inspectContainers(inspectNames)
    : { containers: {}, disabled: true };

  // Ultrafeeder declares which aggregators it feeds — parse it so those are
  // auto-detected rather than hand-listed.
  const uf = (mode === 'local' || mode === 'remote')
    ? await dockerInspect.ultrafeederConfig()
    : { available: false };

  const feeders = {};
  const order = [];

  for (const f of catalog) {
    order.push(f.key);
    // Shared display metadata, served inline so the frontend needs no catalog fetch.
    const base = {
      key: f.key, name: f.name, color: f.color, initials: f.initials,
      public_url: f.public_url, detail_url: f.detail_url || null,
      mlat: !!f.mlat, detect: f.detect, note: f.note || '',
    };

    if (f.detect.type === 'realtime') {
      const data = rtData[f.key];
      feeders[f.key] = data
        ? { ...base, source: 'realtime', installed: true, ...(f.detect.probe === 'fr24' ? parseFr24(data) : parsePiaware(data)) }
        : { ...base, source: 'realtime', installed: false, status: 'not_installed' };
      continue;
    }

    if (f.detect.type === 'docker') {
      const c = dh.containers[f.detect.container];
      if (c) {
        const st = dockerStatus(c);
        feeders[f.key] = {
          ...base, source: 'docker', installed: true, status: st,
          docker: { health: c.health, uptime_seconds: c.uptime_seconds, restarts: c.restarts, stale: !!dh.stale },
          // MLAT health isn't exposed by docker inspect; surface the catalog's
          // assumed status while the container is up so the MLAT panel still lists it.
          mlat_status: (f.mlat && st === 'connected') ? (f.mlat_status || null) : null,
        };
      } else if (enabled.has(f.key)) {
        feeders[f.key] = { ...base, source: 'audit', installed: true, status: 'connected', mlat_status: f.mlat_status || null };
      } else {
        feeders[f.key] = { ...base, source: 'audit', installed: false, status: 'not_installed' };
      }
      continue;
    }

    if (f.detect.type === 'ultrafeeder') {
      const m = f.detect.match;
      const fed = uf.available && uf.running && m && uf.adsbHosts.some(h => h.includes(m));
      if (fed) {
        const hasMlat = f.mlat && uf.mlatHosts.some(h => h.includes(m));
        feeders[f.key] = { ...base, source: 'ultrafeeder', installed: true, status: 'connected',
          mlat_status: hasMlat ? (f.mlat_status || 'active') : null };
      } else if (enabled.has(f.key)) {
        feeders[f.key] = { ...base, source: 'audit', installed: true, status: 'connected', mlat_status: f.mlat_status || null };
      } else {
        feeders[f.key] = { ...base, source: 'audit', installed: false, status: 'not_installed' };
      }
      continue;
    }

    // static: installed only when force-enabled (off-mode / un-probeable feeders).
    feeders[f.key] = enabled.has(f.key)
      ? { ...base, source: 'audit', installed: true, status: 'connected', mlat_status: f.mlat_status || null }
      : { ...base, source: 'audit', installed: false, status: 'not_installed', note: f.note || 'Not configured on this host' };
  }

  // Non-feeder local services for the main-page link grid. `detected` is false
  // when docker detection couldn't run, so the UI can leave those links alone
  // rather than wrongly grey/hide them.
  const dockerDetected = !dh.disabled && !dh.unavailable;
  const services = {};
  for (const [key, container] of Object.entries(SERVICE_CONTAINERS)) {
    const c = dh.containers[container];
    services[key] = { installed: !!c, status: dockerStatus(c), detected: dockerDetected };
  }

  // Add monitoring services
  for (const [key, ok] of Object.entries(monData)) {
    services[key] = {
      installed: true,
      status: ok ? 'connected' : 'offline',
      detected: true
    };
  }

  return {
    updated_at:  new Date().toISOString(),
    station:     { lat: station.lat, lon: station.lon, alt_ft: station.alt_ft },
    detect_mode: mode,
    hide_uninstalled_links: getSetting('hide_uninstalled_links'),
    services,
    docker:      { disabled: !!dh.disabled, unavailable: !!dh.unavailable, stale: !!dh.stale, reason: dh.reason || null },
    order,
    feeders,
    fr24:        rtData.fr24    || null,  // raw payloads for the detail pages
    piaware:     rtData.piaware || null,
  };
});

// Let server.js drop the cached feeder/docker results when detection settings change.
function bustFeederCache() { delete _cache['feeders']; delete _cache['docker']; }

router.get('/feeders', async (req, res) => {
  try { res.json(await getFeeders()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /api/adsb/docker-health ───────────────────────────────────────
// Thin compat alias — feeder status now folds docker health into /feeders, but
// this endpoint stays for any external callers. Same container map as before.
const getDockerHealth = withCache('docker', 30000, async () => {
  const dh = await dockerInspect.inspectContainers(dockerFeeders().map(d => d.container));
  return {
    updated_at: dh.updated_at || new Date().toISOString(),
    containers: dh.containers || {},
    disabled:   !!dh.disabled,
    stale:      !!dh.stale,
    unavailable: !!dh.unavailable,
    reason:     dh.reason || undefined,
  };
});

router.get('/docker-health', async (req, res) => {
  try { res.json(await getDockerHealth()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/aircraft', async (req, res) => {
  try { res.json(await getAircraft()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/live', async (req, res) => {
  try { res.json(await getLive()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/outline', async (req, res) => {
  try {
    const data = await safeFetch(`${BASE}/data/outline.json`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Receiver outline unavailable' });
  }
});

router.get('/stats', async (req, res) => {
  try { res.json(await getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.bustFeederCache = bustFeederCache;
router.getFeeders = getFeeders;
module.exports = router;
