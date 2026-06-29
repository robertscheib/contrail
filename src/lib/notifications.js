const fetch = require('node-fetch');
const { getSetting } = require('../db/settings');
const { resolveRegistration } = require('./registration-lookup');
const { resolveRoute } = require('./route-lookup');

/**
 * Triggers notifications for an interesting aircraft across all enabled channels.
 * @param {object} ac - The live aircraft object from the feed
 * @param {object} match - The watchlist record from interesting_aircraft
 */
async function triggerNotification(ac, match) {
  try {
    if (!getSetting('notify_enabled')) return;

    // 1. Filter by category
    const cat = (match.category || 'other').trim().toLowerCase();
    if (!getSetting(`notify_cat_${cat}`)) return;

    // 2. Filter by altitude
    const alt = ac.alt_baro ?? ac.ft_baro ?? null;
    const maxAlt = getSetting('notify_max_altitude_ft');
    if (maxAlt > 0 && alt !== null && alt > maxAlt) return;

    // 3. Filter by distance
    const dist = ac.dist_nm ?? null;
    const maxDist = getSetting('notify_max_distance_nm');
    if (maxDist > 0 && dist !== null && dist > maxDist) return;

    // 4. Enrich details
    const [regDetails, routeDetails] = await Promise.all([
      resolveRegistration(ac.hex).catch(() => null),
      ac.flight ? resolveRoute(ac.flight).catch(() => null) : null
    ]);

    const info = {
      hex:          ac.hex.toUpperCase(),
      flight:       (ac.flight || '').trim() || 'N/A',
      registration: match.registration || regDetails?.registration || 'N/A',
      operator:     match.operator || regDetails?.owner || 'N/A',
      type:         match.type || regDetails?.type || 'N/A',
      category:     match.category || 'other',
      tags:         [match.tag1, match.tag2, match.tag3].filter(Boolean).join(', ') || 'None',
      photoUrl:     match.image_link || regDetails?.photo_url || null,
      route:        routeDetails ? `${routeDetails.origin} ➔ ${routeDetails.destination}` : 'N/A',
      altitude:     alt !== null ? `${alt.toLocaleString()} ft` : 'N/A',
      speed:        ac.gs != null ? `${Math.round(ac.gs)} kts` : 'N/A',
      squawk:       ac.squawk || 'N/A',
      distance:     dist !== null ? `${dist.toFixed(1)} nm` : 'N/A',
      latitude:     ac.lat ?? null,
      longitude:    ac.lon ?? null,
    };

    const baseUrl = getSetting('notify_base_url') || '';
    info.link = baseUrl ? `${baseUrl.replace(/\/$/, '')}/?icao=${ac.hex}` : null;

    // 5. Dispatch to enabled services
    const promises = [];

    if (getSetting('notify_discord_enabled')) {
      promises.push(sendDiscord(info).catch(err => console.error('[notify] Discord failed:', err.message)));
    }
    if (getSetting('notify_telegram_enabled')) {
      promises.push(sendTelegram(info).catch(err => console.error('[notify] Telegram failed:', err.message)));
    }
    if (getSetting('notify_ha_enabled')) {
      promises.push(sendHomeAssistant(info).catch(err => console.error('[notify] Home Assistant failed:', err.message)));
    }
    if (getSetting('notify_ntfy_enabled')) {
      promises.push(sendNtfy(info).catch(err => console.error('[notify] ntfy failed:', err.message)));
    }
    if (getSetting('notify_pushover_enabled')) {
      promises.push(sendPushover(info).catch(err => console.error('[notify] Pushover failed:', err.message)));
    }

    await Promise.allSettled(promises);
  } catch (err) {
    console.error('[notify] triggerNotification error:', err.message);
  }
}

/**
 * Sends a notification to Discord via Webhook.
 */
async function sendDiscord(info) {
  const webhookUrl = getSetting('notify_discord_webhook');
  if (!webhookUrl) return;

  const embed = {
    title: `🚨 Interesting Aircraft: ${info.flight} (${info.registration})`,
    url: info.link || undefined,
    color: info.category === 'military' ? 0xd11a2a : 0x2f81f7,
    fields: [
      { name: 'Operator', value: info.operator, inline: true },
      { name: 'Type', value: info.type, inline: true },
      { name: 'Category', value: info.category, inline: true },
      { name: 'Route', value: info.route, inline: true },
      { name: 'Altitude', value: info.altitude, inline: true },
      { name: 'Speed', value: info.speed, inline: true },
      { name: 'Distance', value: info.distance, inline: true },
      { name: 'Squawk', value: info.squawk, inline: true },
      { name: 'Tags', value: info.tags, inline: false },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `ICAO: ${info.hex}` }
  };

  if (info.photoUrl) {
    embed.thumbnail = { url: info.photoUrl };
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Sends a notification to Telegram.
 */
async function sendTelegram(info) {
  const token = getSetting('notify_telegram_bot_token');
  const chatId = getSetting('notify_telegram_chat_id');
  if (!token || !chatId) return;

  const text = `🚨 *Interesting Aircraft Spotted*
*Flight:* ${info.flight} (${info.registration})
*Operator:* ${info.operator}
*Type:* ${info.type}
*Category:* ${info.category}
*Route:* ${info.route}
*Altitude:* ${info.altitude} | *Speed:* ${info.speed}
*Distance:* ${info.distance} | *Squawk:* ${info.squawk}
*Tags:* ${info.tags}
*ICAO:* \`${info.hex}\`
${info.link ? `[✈️ Track Live on Radar](${info.link})` : ''}`;

  let url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    parse_mode: 'Markdown',
  };

  if (info.photoUrl) {
    url = `https://api.telegram.org/bot${token}/sendPhoto`;
    body.photo = info.photoUrl;
    body.caption = text;
  } else {
    body.text = text;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Updates a sensor and device tracker entity in Home Assistant via REST API.
 */
async function sendHomeAssistant(info) {
  const haUrl = getSetting('notify_ha_url');
  const token = getSetting('notify_ha_token');
  let entityId = getSetting('notify_ha_entity_id') || 'sensor.radar_interesting_aircraft';
  
  if (!haUrl || !token) return;

  // Normalize sensor entity ID
  entityId = entityId.trim().toLowerCase();
  if (!entityId.startsWith('sensor.')) {
    entityId = `sensor.${entityId}`;
  }

  const baseHaUrl = haUrl.replace(/\/$/, '');
  const sensorUrl = `${baseHaUrl}/api/states/${entityId}`;
  const trackerUrl = `${baseHaUrl}/api/states/device_tracker.radar_interesting_aircraft`;

  const sensorPayload = {
    state: info.flight !== 'N/A' ? info.flight : info.registration,
    attributes: {
      friendly_name: 'Interesting Aircraft',
      icon: 'mdi:airplane',
      entity_picture: info.photoUrl || undefined,
      hex: info.hex,
      registration: info.registration,
      operator: info.operator,
      type: info.type,
      category: info.category,
      tags: info.tags,
      photo_url: info.photoUrl,
      route: info.route,
      altitude: info.altitude,
      speed: info.speed,
      distance: info.distance,
      squawk: info.squawk,
      link: info.link,
      latitude: info.latitude,
      longitude: info.longitude
    }
  };

  const trackerPayload = {
    state: info.flight !== 'N/A' ? info.flight : info.registration,
    attributes: {
      friendly_name: 'Radar — Nearest Watchlist Aircraft',
      source_type: 'gps',
      gps_accuracy: 0,
      latitude: info.latitude,
      longitude: info.longitude,
      entity_picture: info.photoUrl || undefined,
      hex: info.hex,
      registration: info.registration,
      operator: info.operator,
      type: info.type,
      category: info.category,
      tags: info.tags,
      route: info.route,
      altitude: info.altitude,
      speed: info.speed,
      distance: info.distance,
      squawk: info.squawk,
      link: info.link
    }
  };

  const reqs = [
    fetch(sensorUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sensorPayload)
    })
  ];

  // Only update device tracker if we have valid coordinates
  if (info.latitude !== null && info.longitude !== null) {
    reqs.push(
      fetch(trackerUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(trackerPayload)
      })
    );
  }

  const results = await Promise.all(reqs);
  for (const r of results) {
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    }
  }
}

/**
 * Sends a push notification via ntfy.
 */
async function sendNtfy(info) {
  const serverUrl = getSetting('notify_ntfy_url') || 'https://ntfy.sh';
  const topic = getSetting('notify_ntfy_topic');
  if (!topic) return;

  const url = `${serverUrl.replace(/\/$/, '')}/${topic}`;
  const message = `Operator: ${info.operator}
Type: ${info.type} | Route: ${info.route}
Altitude: ${info.altitude} | Speed: ${info.speed}
Distance: ${info.distance} | Squawk: ${info.squawk}
Tags: ${info.tags}`;

  const headers = {
    'Title': `🚨 Interesting Aircraft: ${info.flight} (${info.registration})`,
    'Tags': info.category === 'military' ? 'airplane,red_circle' : 'airplane,blue_circle',
    'Priority': 'default',
  };

  if (info.link) {
    headers['Click'] = info.link;
  }
  if (info.photoUrl) {
    headers['Attach'] = info.photoUrl;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: message
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

/**
 * Sends a push notification via Pushover.
 */
async function sendPushover(info) {
  const user = getSetting('notify_pushover_user');
  const token = getSetting('notify_pushover_token');
  if (!user || !token) return;

  const message = `Operator: ${info.operator}
Type: ${info.type} | Route: ${info.route}
Altitude: ${info.altitude} | Speed: ${info.speed}
Distance: ${info.distance}
Tags: ${info.tags}`;

  const body = {
    token,
    user,
    title: `🚨 Interesting Aircraft: ${info.flight} (${info.registration})`,
    message,
  };

  if (info.link) {
    body.url = info.link;
    body.url_title = 'Track Live on Radar';
  }

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

module.exports = { triggerNotification };
