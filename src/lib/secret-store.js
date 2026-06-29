// Encrypted credential store (AES-256-GCM, Node built-in crypto — no deps).
// Schema-agnostic keyed KV used to keep secrets (e.g. an SSH password) out of
// the plaintext data/settings.json. Ciphertext lives in data/credentials.enc.
//
// Master key resolution:
//   1. RADAR_SECRET_KEY env (32 bytes, base64) — preferred; keep it in
//      ~/projects/secrets.env so the key never sits next to the ciphertext.
//   2. else auto-generate data/.master.key (0600) on first use, with a loud warn.
//
// Honest limit: anything this process can decrypt, an attacker who already has
// the box + key can also decrypt. Encryption-at-rest here protects backups, git,
// and a casual `cat` — NOT a local compromise. Key-based SSH (store only the key
// path) remains strictly safer and needs no secret here.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const ENC_FILE = path.join(DATA_DIR, 'credentials.enc');
const KEY_FILE = path.join(DATA_DIR, '.master.key');

let _key = null;

function _masterKey() {
  if (_key) return _key;

  const fromEnv = process.env.RADAR_SECRET_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error('RADAR_SECRET_KEY must decode to 32 bytes (base64 of 32 random bytes)');
    }
    _key = buf;
    return _key;
  }

  // Auto-generate a key file (0600). Lazy: only happens when a secret is first stored.
  try {
    _key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (_key.length !== 32) throw new Error('bad length');
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, _key.toString('base64'), { mode: 0o600 });
    console.warn(
      '\n┌─ radar-dash secret-store ─────────────────────────────────────────\n' +
      '│ No RADAR_SECRET_KEY set — generated data/.master.key (0600) to\n' +
      '│ encrypt stored credentials. Back this file up; losing it means\n' +
      '│ re-entering any saved SSH password. To control the key yourself,\n' +
      '│ set RADAR_SECRET_KEY (base64 of 32 random bytes) in secrets.env.\n' +
      '└───────────────────────────────────────────────────────────────────\n'
    );
  }
  return _key;
}

function _readStore() {
  try { return JSON.parse(fs.readFileSync(ENC_FILE, 'utf8')); }
  catch { return {}; }
}

function _writeStore(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ENC_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

// Store (or, with empty/null plaintext, delete) a secret.
function setSecret(key, plaintext) {
  const store = _readStore();
  if (plaintext == null || plaintext === '') {
    delete store[key];
    _writeStore(store);
    return;
  }
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _masterKey(), iv);
  const data   = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  store[key] = {
    iv:   iv.toString('base64'),
    tag:  cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  _writeStore(store);
}

// Decrypt on demand. Returns null on absence or auth-tag failure (e.g. the
// master key changed) — never throws, so a rotated key just shows "not set".
function getSecret(key) {
  const rec = _readStore()[key];
  if (!rec) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', _masterKey(), Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    console.warn(`[secret-store] could not decrypt "${key}" (master key changed?):`, e.message);
    return null;
  }
}

function hasSecret(key) {
  return !!_readStore()[key];
}

module.exports = { setSecret, getSecret, hasSecret };
