// Feeder catalog accessor. The catalog (feeders.json) is the single source of
// truth for every known aggregator: display metadata + how to detect it.
// Both adsb.js (status API) and the frontend (served inline via the API) read it.
const CATALOG = require('./feeders.json');

const _byKey = new Map(CATALOG.map(f => [f.key, f]));

function getCatalog() { return CATALOG; }
function byKey(key)   { return _byKey.get(key); }

// [{ key, container }] for every docker-detected feeder — replaces the old
// hardcoded DOCKER_CONTAINERS array and DOCKER_KEY map.
function dockerFeeders() {
  return CATALOG
    .filter(f => f.detect && f.detect.type === 'docker' && f.detect.container)
    .map(f => ({ key: f.key, container: f.detect.container }));
}

// [{ key, port, path, probe }] for realtime-polled feeders (fr24, piaware).
function realtimeFeeders() {
  return CATALOG
    .filter(f => f.detect && f.detect.type === 'realtime')
    .map(f => ({ key: f.key, port: f.detect.port, path: f.detect.path, probe: f.detect.probe }));
}

module.exports = { getCatalog, byKey, dockerFeeders, realtimeFeeders };
