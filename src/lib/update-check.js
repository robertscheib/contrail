// update-check.js — lightweight "newer version available" detector.
//
// Aimed at Docker deployers: compares the running app version against the
// version published to the public repo, and surfaces a flag + a link to the
// update instructions. All network access is best-effort and cached; failures
// are swallowed so this can never break the dashboard.
//
// Config (all optional, env):
//   UPDATE_CHECK_ENABLED   "false" disables the check entirely (default on)
//   UPDATE_CHECK_URL       raw URL to a package.json whose .version is "latest"
//   UPDATE_DOC_URL         link shown to the user for how-to-update steps
//   UPDATE_CHECK_INTERVAL_HOURS   re-check cadence (default 12)

const fs = require('fs');

const CURRENT = require('../../package.json').version;

const ENABLED = process.env.UPDATE_CHECK_ENABLED !== 'false';
const CHECK_URL = process.env.UPDATE_CHECK_URL
  || 'https://raw.githubusercontent.com/tempeduck/contrail/main/package.json';
const DOC_URL = process.env.UPDATE_DOC_URL
  || 'https://github.com/tempeduck/contrail/blob/main/UPDATING.md';
const INTERVAL_MS = Math.max(1, parseInt(process.env.UPDATE_CHECK_INTERVAL_HOURS || '12', 10)) * 3600_000;

// Detect a containerised runtime: explicit env, the Docker sentinel file, or a
// cgroup that mentions docker/containerd/kubepods.
let _inDocker = null;
function isDocker() {
  if (_inDocker !== null) return _inDocker;
  if (/^(1|true|yes)$/i.test(process.env.RADAR_IN_DOCKER || '')) return (_inDocker = true);
  try { if (fs.existsSync('/.dockerenv')) return (_inDocker = true); } catch {}
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf8');
    if (/docker|containerd|kubepods/.test(cg)) return (_inDocker = true);
  } catch {}
  return (_inDocker = false);
}

// Compare dotted numeric versions; returns true if `latest` > `current`.
function isNewer(latest, current) {
  const norm = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = norm(latest), b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

let _state = {
  current: CURRENT,
  latest: null,
  updateAvailable: false,
  inDocker: isDocker(),
  docUrl: DOC_URL,
  checkedAt: 0,
  error: null,
};

async function refresh() {
  if (!ENABLED) return _state;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(CHECK_URL, { signal: ctrl.signal, headers: { 'User-Agent': 'radar-dash-update-check' } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const pkg = await r.json();
    const latest = pkg && pkg.version;
    _state = {
      ..._state,
      latest,
      updateAvailable: !!latest && isNewer(latest, CURRENT),
      checkedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    _state = { ..._state, checkedAt: Date.now(), error: e.message };
  }
  return _state;
}

// Returns the cached status, refreshing in the background when stale.
function getUpdateStatus() {
  if (ENABLED && Date.now() - _state.checkedAt > INTERVAL_MS) refresh();
  return _state;
}

module.exports = { getUpdateStatus, refresh, isDocker, isNewer, ENABLED };
