const fetch = require('node-fetch');
const { getCachedRegistration, upsertRegistration } = require('../db/routes');

// Resolve aircraft registration + photo from adsbdb by ICAO24 hex.
// Cached in registration_cache (90-day hits, 3-day misses). Returns the
// normalized record or null.
async function resolveRegistration(rawHex) {
  const hex = (rawHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;

  const cached = getCachedRegistration(hex);
  if (cached !== null) return cached.registration ? cached : null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${hex}`, {
      headers: { 'user-agent': 'radar-dash/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (res.status === 404 || !res.ok) {
      upsertRegistration({ hex }); // cache miss
      return null;
    }

    const data = await res.json();
    const a = data?.response?.aircraft;
    if (!a) { upsertRegistration({ hex }); return null; }

    const rec = {
      hex,
      registration: a.registration || null,
      icao_type:    a.icao_type    || null,
      type:         a.type         || null,
      manufacturer: a.manufacturer || null,
      owner:        a.registered_owner || null,
      country:      a.registered_owner_country_iso_name || null,
      photo_url:    a.url_photo           || null,
      photo_thumb:  a.url_photo_thumbnail || null,
    };

    // Fallback: If registration is found but photo is missing, query AeroAPI
    if (rec.registration && !rec.photo_url) {
      try {
        const { getAeroApiPhoto } = require('./aeroapi');
        const photo = await getAeroApiPhoto(rec.registration);
        if (photo) {
          rec.photo_url = photo;
          rec.photo_thumb = photo;
        }
      } catch (e) {
        console.error('[aeroapi] Photo lookup failed:', e.message);
      }
    }

    upsertRegistration(rec);
    return rec;
  } catch {
    clearTimeout(timer);
    return null; // network error — do not cache
  }
}

module.exports = { resolveRegistration };
