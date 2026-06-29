const fetch = require('node-fetch');
const { getSetting } = require('../db/settings');

// Fetch JSON from AeroAPI v3
async function aeroApiFetch(path) {
  const apiKey = getSetting('aeroapi_key');
  if (!apiKey) return null;

  try {
    const r = await fetch(`https://aeroapi.flightaware.com/aeroapi${path}`, {
      headers: {
        'x-apikey': apiKey,
        'Accept': 'application/json; charset=UTF-8'
      },
      timeout: 8000
    });
    if (!r.ok) {
      console.warn(`[aeroapi] HTTP error ${r.status} on ${path}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(`[aeroapi] Fetch failed on ${path}:`, e.message);
    return null;
  }
}

// Get photo by registration
async function getAeroApiPhoto(registration) {
  if (!registration) return null;
  const data = await aeroApiFetch(`/aircraft/${registration}/photos`);
  if (data && Array.isArray(data.photos) && data.photos.length > 0) {
    // Return the first photo's thumbnail or full link
    return data.photos[0].thumbnail || data.photos[0].link || null;
  }
  return null;
}

// Get route by callsign (ident)
async function getAeroApiRoute(callsign) {
  if (!callsign) return null;
  const cleanCs = callsign.trim().toUpperCase();
  const data = await aeroApiFetch(`/flights/${cleanCs}`);
  if (data && Array.isArray(data.flights) && data.flights.length > 0) {
    // Find the most recent flight record
    const flight = data.flights[0];
    if (flight.origin && flight.destination) {
      // Helper to calculate distance
      const kmBetween = (lat1, lon1, lat2, lon2) => {
        if ([lat1, lon1, lat2, lon2].some(v => v == null)) return null;
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
      };

      const o = flight.origin;
      const d = flight.destination;

      return {
        origin: o.code_iata || o.code || null,
        destination: d.code_iata || d.code || null,
        origin_name: o.name || null,
        destination_name: d.name || null,
        origin_country: null, // AeroAPI v3 doesn't return ISO country directly here
        destination_country: null,
        airline_name: flight.operator || null,
        route_km: kmBetween(o.latitude, o.longitude, d.latitude, d.longitude),
        origin_lat: o.latitude ?? null,
        origin_lon: o.longitude ?? null,
        dest_lat: d.latitude ?? null,
        dest_lon: d.longitude ?? null
      };
    }
  }
  return null;
}

module.exports = {
  getAeroApiPhoto,
  getAeroApiRoute
};
