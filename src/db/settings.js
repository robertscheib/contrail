// Runtime-editable settings. JSON-file backed (data/settings.json), with each
// key's default derived from its env var (so existing env config keeps working).
// Stored values override env at runtime; the settings page writes here.
const fs = require('fs');
const path = require('path');
const secretStore = require('../lib/secret-store');

const FILE = path.join(__dirname, '../../data/settings.json');

// Load feeders catalog for multiselect
const feedersCatalog = require('../data/feeders.json');
const feederOptions = Object.entries(feedersCatalog).map(([key, f]) => [key, f.name]);

// Country list for dropdown
const COUNTRIES = [
  ['US', 'United States (USA)'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['IT', 'Italy'],
  ['ES', 'Spain'],
  ['NL', 'Netherlands'],
  ['IE', 'Ireland'],
  ['CH', 'Switzerland'],
  ['BE', 'Belgium'],
  ['AT', 'Austria'],
  ['SE', 'Sweden'],
  ['NO', 'Norway'],
  ['FI', 'Finland'],
  ['DK', 'Denmark'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['ZA', 'South Africa'],
  ['BR', 'Brazil'],
  ['AR', 'Argentina'],
  ['MX', 'Mexico'],
  ['JP', 'Japan'],
  ['KR', 'South Korea'],
  ['CN', 'China'],
  ['IN', 'India'],
  ['SG', 'Singapore'],
  ['MY', 'Malaysia'],
  ['TH', 'Thailand'],
  ['PH', 'Philippines'],
  ['ID', 'Indonesia'],
  ['VN', 'Vietnam'],
  ['TR', 'Turkey'],
  ['IL', 'Israel'],
  ['AE', 'United Arab Emirates'],
  ['SA', 'Saudi Arabia'],
  ['EG', 'Egypt'],
  ['GR', 'Greece'],
  ['UA', 'Ukraine'],
  ['RO', 'Romania'],
  ['CZ', 'Czechia'],
  ['HU', 'Hungary'],
  ['HR', 'Croatia'],
  ['BG', 'Bulgaria'],
  ['SK', 'Slovakia'],
  ['IS', 'Iceland'],
  ['LU', 'Luxembourg'],
  ['CL', 'Chile'],
  ['CO', 'Colombia'],
  ['PE', 'Peru'],
  ['VE', 'Venezuela'],
  ['TW', 'Taiwan'],
  ['HK', 'Hong Kong'],
  ['MO', 'Macau'],
  ['MA', 'Morocco'],
  ['DZ', 'Algeria'],
  ['TN', 'Tunisia'],
  ['KE', 'Kenya'],
  ['NG', 'Nigeria'],
  ['GH', 'Ghana'],
  ['QA', 'Qatar'],
  ['KW', 'Kuwait'],
  ['OM', 'Oman'],
  ['BH', 'Bahrain'],
  ['JO', 'Jordan'],
  ['LB', 'Lebanon'],
  ['CR', 'Costa Rica'],
  ['PA', 'Panama'],
  ['DO', 'Dominican Republic'],
  ['PR', 'Puerto Rico'],
  ['BS', 'Bahamas'],
  ['JM', 'Jamaica'],
  ['UY', 'Uruguay'],
  ['EC', 'Ecuador'],
  ['BO', 'Bolivia'],
  ['PY', 'Paraguay'],
];

function envNum(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

// Each setting: type, default, bounds, UI label/help, and whether a change needs
// a service restart to take effect (intervals/connections do; per-request reads don't).
const SCHEMA = {
  // ── Feeder detection ──────────────────────────────────────────────
  // How the dashboard discovers which aggregator feeders are running. The
  // dashboard only READS state (HTTP probes + read-only `docker inspect`); it
  // never edits the feeder stack.
  feeder_detect_mode: {
    type: 'enum', label: 'Feeder detection', group: 'Feeder detection',
    help: 'How feeder install/health is detected. "local" inspects the Docker daemon on this box (dashboard + feeders on one host). "remote" runs docker inspect over SSH on the receiver. "off" disables detection — feeders are taken from the manual list below.',
    default: process.env.ADSB_SSH_HOST ? 'remote' : 'off',
    options: ['local', 'remote', 'off'], restart: false,
  },
  feeder_enabled_keys: {
    type: 'multiselect', label: 'Force-enable feeders', group: 'Feeder detection',
    help: 'Select feeders to mark as installed even when not auto-detected (e.g. for "off" mode, or a feeder we cannot probe).',
    default: (process.env.FEEDER_ENABLED_KEYS || ''), options: feederOptions, restart: false,
  },
  hide_uninstalled_links: {
    type: 'bool', label: 'Hide links for not-installed feeders', group: 'Feeder detection',
    help: 'On the Feeders page, links to a feeder’s stats page are greyed out when that feed isn’t running. Turn this on to hide them entirely for feeders that aren’t installed.',
    default: false, restart: false,
  },
  ssh_host: {
    type: 'string', label: 'SSH host', group: 'Feeder detection',
    help: 'Receiver host/IP for remote detection.',
    default: (process.env.ADSB_SSH_HOST || ''), restart: false,
    showIf: { feeder_detect_mode: ['remote'] },
  },
  ssh_user: {
    type: 'string', label: 'SSH user', group: 'Feeder detection',
    help: 'SSH username on the receiver.',
    default: (process.env.ADSB_SSH_USER || 'root'), restart: false,
    showIf: { feeder_detect_mode: ['remote'] },
  },
  ssh_auth: {
    type: 'enum', label: 'SSH auth', group: 'Feeder detection',
    help: 'Key-based is strongly preferred (only the key path is stored). Password auth is encrypted at rest and needs sshpass on this host.',
    default: 'key', options: ['key', 'password'], restart: false,
    showIf: { feeder_detect_mode: ['remote'] },
  },
  ssh_key_path: {
    type: 'string', label: 'SSH key path', group: 'Feeder detection',
    help: 'Path to the private key on THIS host (the key itself is never stored or transmitted).',
    default: (process.env.ADSB_SSH_KEY || `${process.env.HOME}/.ssh/id_ed25519`), restart: false,
    showIf: { feeder_detect_mode: ['remote'], ssh_auth: ['key'] },
  },
  ssh_password: {
    type: 'secret', label: 'SSH password', group: 'Feeder detection',
    help: 'Stored encrypted (AES-256-GCM) in data/credentials.enc, never written to settings.json and never sent back to the browser. Leave blank to keep the current value.',
    restart: false,
    showIf: { feeder_detect_mode: ['remote'], ssh_auth: ['password'] },
  },

  above_radius_nm: {
    type: 'number', label: 'Above Me radius (nm)', group: 'Above Me',
    help: 'Only aircraft within this many nautical miles count as overhead. 0 = no limit (just nearest N).',
    default: envNum('ABOVE_RADIUS_NM', 25), min: 0, max: 300, step: 1, restart: false,
  },
  above_count: {
    type: 'number', label: 'Above Me count', group: 'Above Me',
    help: 'How many aircraft the Above Me panel lists.',
    default: envInt('ABOVE_COUNT', 6), min: 1, max: 20, step: 1, restart: false,
  },
  route_max_detour_km: {
    type: 'number', label: 'Route detour max (km)', group: 'Route matching',
    help: 'Max extra distance a positioned aircraft may be off its direct origin→dest path before the route is dropped as a bad match. Higher keeps more diversions; lower is stricter.',
    default: envNum('ROUTE_MAX_DETOUR_KM', 450), min: 50, max: 2000, step: 10, restart: false,
  },
  route_max_crosstrack_km: {
    type: 'number', label: 'Route cross-track max (km)', group: 'Route matching',
    help: 'For positionless aircraft: how far the route great-circle may pass from home before it is dropped. ≈ receiver max range + margin.',
    default: envNum('ROUTE_MAX_CROSSTRACK_KM', 500), min: 50, max: 2000, step: 10, restart: false,
  },
  home_country_iso: {
    type: 'enum', label: 'Home country', group: 'General',
    help: 'Select your home country. Used for the domestic / international split in records.',
    default: (process.env.HOME_COUNTRY_ISO || 'US').toUpperCase(), options: COUNTRIES, restart: false,
  },
  interesting_poll_ms: {
    type: 'number', label: 'Interesting poll (ms)', group: 'General',
    help: 'How often the watchlist matcher runs against live aircraft. Lower = catches more brief transits. Requires a service restart to take effect.',
    default: envInt('INTERESTING_POLL_MS', 10000), min: 2000, max: 60000, step: 1000, restart: true,
  },
  paths_scope: {
    type: 'enum', label: 'Flight-path scope', group: 'Flight paths',
    help: 'Which aircraft the Paths/Path-Heat maps accumulate. "All in range" mirrors tar1090’s Tracks map (every aircraft the receiver sees); "Overhead" limits to within the Above Me radius.',
    default: (process.env.PATHS_SCOPE || 'all'), options: ['all', 'overhead'], restart: false,
  },
  paths_max_aircraft: {
    type: 'number', label: 'Flight-path fetch budget', group: 'Flight paths',
    help: 'Max NEW aircraft tracks fetched from ADSBExchange per accumulator cycle (120s). Known aircraft refresh for free; the rest are picked up over later cycles. Higher fills the maps faster but adds trace-API load.',
    default: envInt('PATHS_MAX_AIRCRAFT', 20), min: 1, max: 60, step: 1, restart: false,
  },
  pathheat_window_hours: {
    type: 'number', label: 'Path-heat window (hours)', group: 'Flight paths',
    help: 'The Path Heat map accumulates the full paths of every aircraft overhead within this many hours. Default 24 h matches tar1090’s heatmap window. Persisted to disk, so it survives restarts.',
    default: envNum('PATHHEAT_WINDOW_HOURS', 24), min: 1, max: 24, step: 1, restart: false,
  },
  aeroapi_key: {
    type: 'secret', label: 'FlightAware AeroAPI Key', group: 'General',
    help: 'Your FlightAware AeroAPI v3 key. Used as a high-quality fallback for aircraft photos, registrations, and routes.',
    restart: false,
  },

  // ── Notifications ─────────────────────────────────────────────────
  notify_enabled: {
    type: 'bool', label: 'Enable notifications', group: 'Notifications',
    help: 'Enable notifications when interesting aircraft are spotted.',
    default: false, restart: false,
  },
  notify_cat_military: {
    type: 'bool', label: 'Notify on Military', group: 'Notifications',
    help: 'Trigger alerts for military aircraft.',
    default: true, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_cat_government: {
    type: 'bool', label: 'Notify on Government', group: 'Notifications',
    help: 'Trigger alerts for government aircraft.',
    default: true, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_cat_police: {
    type: 'bool', label: 'Notify on Police', group: 'Notifications',
    help: 'Trigger alerts for law enforcement/police aircraft.',
    default: true, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_cat_civilian: {
    type: 'bool', label: 'Notify on Civilian (Notable)', group: 'Notifications',
    help: 'Trigger alerts for notable civilian aircraft.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_cat_other: {
    type: 'bool', label: 'Notify on Other', group: 'Notifications',
    help: 'Trigger alerts for uncategorized watchlist aircraft.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_max_altitude_ft: {
    type: 'number', label: 'Max altitude filter (ft)', group: 'Notifications',
    help: 'Only notify if the aircraft is below this altitude. 0 = no limit.',
    default: 0, min: 0, max: 50000, step: 1000, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_max_distance_nm: {
    type: 'number', label: 'Max distance filter (nm)', group: 'Notifications',
    help: 'Only notify if the aircraft is within this distance. 0 = no limit.',
    default: 0, min: 0, max: 300, step: 5, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_base_url: {
    type: 'string', label: 'Dashboard Base URL', group: 'Notifications',
    help: 'The base URL of your public dashboard (e.g. https://radar.yourdomain.com) used to construct click-through links. If blank, links will default to relative or localhost.',
    default: process.env.BRAND_DOMAIN ? `https://${process.env.BRAND_NAME}.${process.env.BRAND_DOMAIN}` : '', restart: false,
    showIf: { notify_enabled: [true] },
  },
  // Home Assistant (REST API)
  notify_ha_enabled: {
    type: 'bool', label: 'Enable Home Assistant', group: 'Notifications',
    help: 'Update a sensor entity in Home Assistant via its REST API.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_ha_url: {
    type: 'string', label: 'Home Assistant URL', group: 'Notifications',
    help: 'The base URL of your Home Assistant instance (e.g. http://192.168.1.100:8123 or https://your-ha.example.com).',
    default: '', restart: false,
    showIf: { notify_enabled: [true], notify_ha_enabled: [true] },
  },
  notify_ha_token: {
    type: 'secret', label: 'Home Assistant Long-Lived Access Token', group: 'Notifications',
    help: 'The Long-Lived Access Token generated in your Home Assistant user profile.',
    restart: false,
    showIf: { notify_enabled: [true], notify_ha_enabled: [true] },
  },
  notify_ha_entity_id: {
    type: 'string', label: 'Home Assistant Entity ID', group: 'Notifications',
    help: 'The sensor entity ID to update.',
    default: 'sensor.radar_interesting_aircraft', restart: false,
    showIf: { notify_enabled: [true], notify_ha_enabled: [true] },
  },
  // Discord
  notify_discord_enabled: {
    type: 'bool', label: 'Enable Discord', group: 'Notifications',
    help: 'Send notifications to a Discord channel via Webhook.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_discord_webhook: {
    type: 'secret', label: 'Discord Webhook URL', group: 'Notifications',
    help: 'Paste your Discord channel webhook URL.',
    restart: false,
    showIf: { notify_enabled: [true], notify_discord_enabled: [true] },
  },
  // Telegram
  notify_telegram_enabled: {
    type: 'bool', label: 'Enable Telegram', group: 'Notifications',
    help: 'Send notifications to a Telegram chat/channel.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_telegram_bot_token: {
    type: 'secret', label: 'Telegram Bot Token', group: 'Notifications',
    help: 'The API token for your Telegram bot.',
    restart: false,
    showIf: { notify_enabled: [true], notify_telegram_enabled: [true] },
  },
  notify_telegram_chat_id: {
    type: 'string', label: 'Telegram Chat ID', group: 'Notifications',
    help: 'The chat ID or channel username (e.g. @mychannel or -10012345678) where the bot should send messages.',
    default: '', restart: false,
    showIf: { notify_enabled: [true], notify_telegram_enabled: [true] },
  },
  // ntfy.sh
  notify_ntfy_enabled: {
    type: 'bool', label: 'Enable ntfy', group: 'Notifications',
    help: 'Send push notifications via ntfy.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_ntfy_url: {
    type: 'string', label: 'ntfy Server URL', group: 'Notifications',
    help: 'The ntfy server instance. Default is the public service.',
    default: 'https://ntfy.sh', restart: false,
    showIf: { notify_enabled: [true], notify_ntfy_enabled: [true] },
  },
  notify_ntfy_topic: {
    type: 'string', label: 'ntfy Topic', group: 'Notifications',
    help: 'The topic name to publish to (e.g., my_planes_alert).',
    default: '', restart: false,
    showIf: { notify_enabled: [true], notify_ntfy_enabled: [true] },
  },
  // Pushover
  notify_pushover_enabled: {
    type: 'bool', label: 'Enable Pushover', group: 'Notifications',
    help: 'Send push notifications via Pushover.',
    default: false, restart: false,
    showIf: { notify_enabled: [true] },
  },
  notify_pushover_user: {
    type: 'secret', label: 'Pushover User Key', group: 'Notifications',
    help: 'Your Pushover User Key.',
    restart: false,
    showIf: { notify_enabled: [true], notify_pushover_enabled: [true] },
  },
  notify_pushover_token: {
    type: 'secret', label: 'Pushover API Token', group: 'Notifications',
    help: 'Your Pushover Application API Token.',
    restart: false,
    showIf: { notify_enabled: [true], notify_pushover_enabled: [true] },
  },
};

// Keys whose values are kept in the encrypted credential store, never in settings.json.
const SECRET_KEYS = Object.keys(SCHEMA).filter(k => SCHEMA[k].type === 'secret');

let _cache = null;
function _load() {
  if (_cache) return _cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* no file yet */ }
  _cache = {};
  for (const [k, def] of Object.entries(SCHEMA)) {
    if (def.type === 'secret') continue;   // secrets live in the encrypted store, not here
    _cache[k] = (k in stored) ? stored[k] : def.default;
  }
  return _cache;
}

function getSetting(key) {
  const def = SCHEMA[key];
  if (def && def.type === 'secret') return secretStore.getSecret(key);
  return _load()[key];
}
function getAllSettings() {
  return { ..._load() };   // non-secret values only
}
// Like getAllSettings but safe to send to the browser: secret values are
// replaced with the string "set"/"not set" so the password never leaks.
function getRedactedSettings() {
  const out = { ...getAllSettings() };
  for (const k of SECRET_KEYS) out[k] = secretStore.hasSecret(k) ? 'set' : 'not set';
  return out;
}
// Helper to strip complex objects/arrays from the schema before sending to the client,
// ensuring the client only gets clean lists.
function getSchema() {
  const out = {};
  for (const [k, d] of Object.entries(SCHEMA)) out[k] = { ...d };
  return out;
}

function _coerce(key, val) {
  const def = SCHEMA[key];
  if (!def) return undefined;
  if (def.type === 'number') {
    let n = Number(val);
    if (!Number.isFinite(n)) return undefined;
    if (def.min != null) n = Math.max(def.min, n);
    if (def.max != null) n = Math.min(def.max, n);
    return n;
  }
  if (def.type === 'string') {
    let s = String(val).trim();
    if (key === 'home_country_iso') s = s.toUpperCase();
    if (def.pattern && !new RegExp(def.pattern).test(s)) return undefined;
    return s;
  }
  if (def.type === 'enum') {
    const s = String(val).trim();
    const flatOptions = (def.options || []).map(o => Array.isArray(o) ? o[0] : o);
    return flatOptions.includes(s) ? s : undefined;
  }
  if (def.type === 'multiselect') {
    const s = String(val).trim();
    const flatOptions = (def.options || []).map(o => Array.isArray(o) ? o[0] : o);
    const parts = s.split(',').map(p => p.trim()).filter(p => flatOptions.includes(p));
    return parts.join(',');
  }
  if (def.type === 'bool') {
    if (typeof val === 'boolean') return val;
    const s = String(val).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
    return undefined;
  }
  return undefined;
}

// Apply a partial update; unknown keys and invalid values are ignored.
// Returns { applied, requiresRestart } where applied is the accepted subset.
function updateSettings(patch) {
  const cur = getAllSettings();
  const applied = {};
  let requiresRestart = false;
  for (const [k, v] of Object.entries(patch || {})) {
    const def = SCHEMA[k];
    if (!def) continue;
    if (def.type === 'secret') {
      // Write-only: an empty submit means "leave unchanged" (the field always
      // renders blank, so we can't tell blank-on-purpose from blank-by-default).
      const s = (v == null ? '' : String(v)).trim();
      if (s === '') continue;
      secretStore.setSecret(k, s);
      applied[k] = 'set';
      if (def.restart) requiresRestart = true;
      continue;
    }
    const c = _coerce(k, v);
    if (c === undefined) continue;
    if (c !== cur[k] && def.restart) requiresRestart = true;
    cur[k] = c;
    applied[k] = c;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cur, null, 2));
  _cache = cur;
  return { applied, requiresRestart };
}

module.exports = {
  getSetting, getAllSettings, getRedactedSettings, getSchema, updateSettings, SCHEMA,
};
