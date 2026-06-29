const fetch = require('node-fetch');
const crypto = require('crypto');
const { upsertManyInteresting, interestingCount, getMeta, setMeta } = require('../db/interesting');

const CSV_URL = process.env.PLANE_ALERT_CSV_URL ||
  'https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db-images.csv';

// #CMPG group code → our category bucket
const GROUP_MAP = { mil: 'military', gov: 'government', pol: 'police', civ: 'civilian' };

// Minimal CSV line splitter that respects double-quoted fields.
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parsePlaneAlertCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const rows = [];
  // Columns: ICAO, Reg, Operator, Type, ICAO Type, CMPG, Tag1, Tag2, Tag3, Category, Link, ImageLink, ...
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const icao = (f[0] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao)) continue;
    const group = (f[5] || '').trim();
    rows.push({
      icao,
      registration: (f[1] || '').trim() || null,
      operator:     (f[2] || '').trim() || null,
      type:         (f[3] || '').trim() || null,
      icao_type:    (f[4] || '').trim() || null,
      group_code:   group || null,
      category:     GROUP_MAP[group.toLowerCase()] || 'other',
      tag1:         (f[6] || '').trim() || null,
      tag2:         (f[7] || '').trim() || null,
      tag3:         (f[8] || '').trim() || null,
      link:         (f[10] || '').trim() || null,
      image_link:   (f[11] || '').trim() || null,
    });
  }
  return rows;
}

// Fetch + load the plane-alert-db. Skips the upsert when the CSV hash is
// unchanged from the last load (unless the table is empty).
async function loadPlaneAlertDb() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(CSV_URL, { headers: { 'user-agent': 'radar-dash/1.0' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[plane-alert] fetch failed: HTTP ${res.status}`); return; }

    const text = await res.text();
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (getMeta('csv_hash') === hash && interestingCount() > 0) {
      console.log('[plane-alert] up to date, skipping load');
      return;
    }

    const rows = parsePlaneAlertCsv(text);
    if (!rows.length) { console.warn('[plane-alert] parsed 0 rows'); return; }
    upsertManyInteresting(rows);
    setMeta('csv_hash', hash);
    setMeta('loaded_at', Date.now());
    console.log(`[plane-alert] loaded ${rows.length} interesting aircraft`);
  } catch (e) {
    console.warn('[plane-alert] load error:', e.message);
  }
}

module.exports = { loadPlaneAlertDb, parsePlaneAlertCsv };
