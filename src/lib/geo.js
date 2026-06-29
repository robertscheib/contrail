// Geographic helpers for route plausibility — reject routes whose flight path
// doesn't actually pass near the receiver (e.g. PDX→LAS showing up over Chicago
// from a callsign collision or a positionless aircraft).
const AIRPORTS = require('../data/airports.json'); // { IATA: [lat, lon] } — OurAirports

const HOME_LAT = parseFloat(process.env.HOME_LAT) || 41.6993;
const HOME_LON = parseFloat(process.env.HOME_LON) || -88.1081;
// A correctly-matched route's great-circle path passes within receiver range of
// home (the aircraft was detected here). Default ~500 km ≈ receiver max range +
// margin; anything farther is a bad match. Override with ROUTE_MAX_CROSSTRACK_KM.
const MAX_CROSSTRACK_KM = parseFloat(process.env.ROUTE_MAX_CROSSTRACK_KM) || 500;
// Extra distance an aircraft may be off the direct origin→dest path before the
// route is treated as a bad match. Generous enough to keep real diversions /
// weather reroutes, tight enough to reject callsign collisions. ROUTE_MAX_DETOUR_KM.
const MAX_DETOUR_KM = parseFloat(process.env.ROUTE_MAX_DETOUR_KM) || 450;

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dLa / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function airportCoords(iata) {
  return AIRPORTS[(iata || '').toUpperCase()] || null;
}

function toXYZ(lat, lon) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

// Shortest distance (km) from point P to the great circle through A and B.
function crossTrackKm(aLat, aLon, bLat, bLon, pLat, pLon) {
  const a = toXYZ(aLat, aLon), b = toXYZ(bLat, bLon), p = toXYZ(pLat, pLon);
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const m = Math.hypot(...n) || 1;
  const d = Math.asin(Math.max(-1, Math.min(1, (n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / m)));
  return Math.abs(d) * 6371;
}

// Does the origin→destination flight path pass within MAX_CROSSTRACK_KM of home?
// Accepts IATA codes (looked up in the airport DB) and/or explicit coords.
// Returns true when coordinates are unavailable (can't disprove → keep).
function routeNearHome(origin, destination, coords = {}, maxKm = MAX_CROSSTRACK_KM) {
  const o = (coords.oLat != null && coords.oLon != null) ? [coords.oLat, coords.oLon] : airportCoords(origin);
  const d = (coords.dLat != null && coords.dLon != null) ? [coords.dLat, coords.dLon] : airportCoords(destination);
  if (!o || !d) return true; // unknown airports — don't drop
  return crossTrackKm(o[0], o[1], d[0], d[1], HOME_LAT, HOME_LON) <= maxKm;
}

// Is the aircraft plausibly flying origin→destination, given its actual position?
// Uses a detour (ellipse) test: extra distance over the direct path must be small.
// Real diversions add a bounded detour and pass; callsign collisions (plane nowhere
// near any path between the two airports) blow the detour out and fail.
// Returns true when coordinates are unavailable (can't disprove → keep).
function routeOnPath(origin, destination, acftLat, acftLon, coords = {}, maxDetourKm = MAX_DETOUR_KM) {
  if (acftLat == null || acftLon == null) return true;
  const o = (coords.oLat != null && coords.oLon != null) ? [coords.oLat, coords.oLon] : airportCoords(origin);
  const d = (coords.dLat != null && coords.dLon != null) ? [coords.dLat, coords.dLon] : airportCoords(destination);
  if (!o || !d) return true; // unknown airports — don't drop
  const direct = haversineKm(o[0], o[1], d[0], d[1]);
  const detour = haversineKm(o[0], o[1], acftLat, acftLon) + haversineKm(acftLat, acftLon, d[0], d[1]);
  return (detour - direct) <= maxDetourKm;
}

module.exports = {
  airportCoords, crossTrackKm, haversineKm, routeNearHome, routeOnPath,
  HOME_LAT, HOME_LON, MAX_CROSSTRACK_KM, MAX_DETOUR_KM,
};
