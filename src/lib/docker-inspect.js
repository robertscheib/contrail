// Mode-aware, read-only Docker inspector. One abstraction over three topologies
// so feeder detection (adsb.js) and RRD backfill (stats-engine.js) share the same
// SSH-command builder instead of duplicating it:
//   local  — talk to the Docker daemon on THIS box (dashboard + feeders co-located)
//   remote — run docker over SSH on the receiver (key or password auth)
//   off    — no detection
//
// Everything here is read-only (`docker inspect` / `docker exec rrdtool`). It never
// starts, stops, or edits containers.
const { exec } = require('child_process');
const { getSetting } = require('../db/settings');

// Snapshot the relevant settings for one operation. Read fresh each call so a
// settings change applies without a restart.
function context() {
  return {
    mode:    getSetting('feeder_detect_mode'),
    host:    getSetting('ssh_host'),
    user:    getSetting('ssh_user'),
    auth:    getSetting('ssh_auth'),
    keyPath: getSetting('ssh_key_path'),
    // password resolved lazily (decrypts) only when actually building a password cmd
  };
}

// Build the SSH command prefix + any extra child-process env. For password auth
// the password goes via the SSHPASS env var of the child — never on argv (which
// would leak through `ps`).
function buildSshPrefix(ctx = context()) {
  const opts = '-o StrictHostKeyChecking=no -o ConnectTimeout=5';
  if (ctx.auth === 'password') {
    const pw = getSetting('ssh_password');
    return {
      prefix: `sshpass -e ssh ${opts} ${ctx.user}@${ctx.host}`,
      env: pw ? { SSHPASS: pw } : {},
    };
  }
  return {
    prefix: `ssh -i ${ctx.keyPath} ${opts} ${ctx.user}@${ctx.host}`,
    env: {},
  };
}

function _exec(cmd, env, timeout = 8000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// Run a docker subcommand (e.g. `inspect a b --format '...'`). Resolves a result
// object — never rejects — so callers can degrade gracefully:
//   { ok, stdout, disabled?, unavailable?, reason? }
async function runDocker(dockerArgs, ctx = context()) {
  if (ctx.mode === 'off') return { ok: false, disabled: true, reason: 'detection off' };

  let cmd, env = {};
  if (ctx.mode === 'remote') {
    if (!ctx.host) return { ok: false, disabled: true, reason: 'no SSH host configured' };
    const ssh = buildSshPrefix(ctx);
    env = ssh.env;
    cmd = `${ssh.prefix} "docker ${dockerArgs}"`;
  } else {
    // local
    cmd = `docker ${dockerArgs}`;
  }

  const { err, stdout, stderr } = await _exec(cmd, env);
  if (err) {
    const msg = stderr || err.message;
    // docker/sshpass not installed, or host unreachable — surface, don't throw.
    const missing = /not found|ENOENT|command not found/i.test(msg);
    // `docker inspect` exits non-zero when ANY name is absent but still prints the
    // ones that exist; keep that partial stdout for the caller to parse.
    return { ok: false, stdout, unavailable: missing, reason: msg };
  }
  return { ok: true, stdout };
}

const INSPECT_FMT =
  '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}';

// Stale-cache so a transient SSH blip doesn't blank the panel. Keyed by the
// detection context — a mode/host change must NOT serve the previous target's
// cached containers.
let _lastGood = null;
let _lastSig  = null;
function _sig(ctx) { return `${ctx.mode}|${ctx.host || ''}|${ctx.user || ''}|${ctx.auth || ''}`; }

// Inspect a set of container names. Returns:
//   { containers:{name:{status,health,restarts,uptime_seconds,started_at}}, updated_at,
//     disabled?, unavailable?, stale?, reason? }
async function inspectContainers(names, ctx = context()) {
  if (ctx.mode === 'off') return { containers: {}, disabled: true, reason: 'detection off' };
  if (!names || !names.length) return { containers: {}, updated_at: new Date().toISOString() };

  const sig = _sig(ctx);
  const res = await runDocker(`inspect ${names.join(' ')} --format '${INSPECT_FMT}' 2>/dev/null`, ctx);

  if (res.disabled) return { containers: {}, disabled: true, reason: res.reason };

  if (!res.ok && !res.stdout) {
    // Hard failure with nothing parseable — fall back to last good for the SAME
    // context only, flagged stale; otherwise report unavailable.
    if (_lastGood && _lastSig === sig) return { ..._lastGood, stale: true, reason: res.reason };
    return { containers: {}, unavailable: true, reason: res.reason };
  }

  const containers = {};
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    const [name, status, health, restarts, startedAt] = line.split('|');
    const key = (name || '').replace(/^\//, '');
    if (!key) continue;
    containers[key] = {
      status,
      health,
      restarts: parseInt(restarts, 10) || 0,
      uptime_seconds: startedAt ? Math.floor((Date.now() - new Date(startedAt)) / 1000) : null,
      started_at: startedAt,
    };
  }
  _lastGood = { containers, updated_at: new Date().toISOString() };
  _lastSig  = sig;
  return { ..._lastGood, stale: false };
}

// Read ultrafeeder's own feed config so ultrafeeder-fed aggregators (adsbexchange,
// adsb.fi, adsb.lol, …) are auto-detected instead of hand-listed. ULTRAFEEDER_CONFIG
// declares every destination, e.g. "adsb,feed1.adsbexchange.com,30004,…; mlat,…".
// Returns { available, running, adsbHosts:[], mlatHosts:[], reason? }.
async function ultrafeederConfig(ctx = context()) {
  if (ctx.mode === 'off') return { available: false, disabled: true, reason: 'detection off' };

  const res = await runDocker(
    `inspect ultrafeeder --format '{{.State.Status}}{{println}}{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null`,
    ctx
  );
  if (!res.ok && !res.stdout) return { available: false, reason: res.reason };

  const lines = res.stdout.split('\n');
  const running = (lines[0] || '').trim() === 'running';
  const cfgLine = lines.find(l => l.startsWith('ULTRAFEEDER_CONFIG=')) || '';
  const cfg = cfgLine.slice('ULTRAFEEDER_CONFIG='.length);

  const adsbHosts = [], mlatHosts = [];
  for (const tok of cfg.split(';').map(s => s.trim()).filter(Boolean)) {
    const p = tok.split(',').map(x => x.trim());
    if (p[0] === 'adsb' && p[1]) adsbHosts.push(p[1]);
    else if (p[0] === 'mlat' && p[1]) mlatHosts.push(p[1]);
  }
  return { available: true, running, adsbHosts, mlatHosts };
}

module.exports = { context, buildSshPrefix, runDocker, inspectContainers, ultrafeederConfig };
