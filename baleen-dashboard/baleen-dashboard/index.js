'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require(process.env.BALEEN_CONFIG || './config.js');
const { Gateway } = require('./modbus');
const { openDb } = require('./db');
const alarms = require('./alarms');

const db = openDb(config.db.file);

// Flatten tag definitions and index by key for quick lookup on the API side.
const tagList = [];
for (const gw of config.gateways) {
  for (const tag of gw.tags) tagList.push({ ...tag, gateway: gw.id });
}
const tagByKey = Object.fromEntries(tagList.map((t) => [t.key, t]));

const gateways = config.gateways.map((gw) => new Gateway(gw, config.modbusTimeoutMs));

// In-memory latest snapshot + last known status (for alarm-transition logging).
const snapshot = {}; // key -> { value, unit, status, ts, quality }
const lastStatus = {}; // key -> status

// ---- poll loop --------------------------------------------------------------
async function pollOnce() {
  const ts = Date.now();
  const rows = [];

  const results = await Promise.all(gateways.map((gw) => gw.poll()));

  for (let i = 0; i < config.gateways.length; i++) {
    const gwCfg = config.gateways[i];
    const readings = results[i];
    for (const tag of gwCfg.tags) {
      const reading = readings[tag.key] || { value: null, quality: 'bad' };
      const status = alarms.evaluate(tag, reading);

      snapshot[tag.key] = {
        value: reading.value,
        unit: tag.unit || '',
        status,
        quality: reading.quality,
        ts,
      };

      if (reading.quality === 'good' && reading.value !== null) {
        rows.push({ ts, tkey: tag.key, value: reading.value });
      }

      // Log alarm/status transitions only (not every sample).
      if (lastStatus[tag.key] !== status) {
        db.writeEvent(ts, tag.key, status, alarms.message(tag, reading, status));
        lastStatus[tag.key] = status;
      }
    }
  }

  db.writeReadings(rows);
  broadcast({ type: 'snapshot', ts, data: snapshot });
}

async function loop() {
  try {
    await pollOnce();
  } catch (err) {
    console.error('[poll] cycle error:', err.message);
  } finally {
    setTimeout(loop, config.pollIntervalMs);
  }
}

// Prune old readings once a day.
setInterval(() => {
  try { db.prune(config.db.retentionDays); } catch (e) { console.error('[prune]', e.message); }
}, 86400_000);

// ---- web server + websocket -------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Tag metadata for the dashboard to build its cards.
app.get('/api/config', (_req, res) => {
  res.json({
    pollIntervalMs: config.pollIntervalMs,
    tags: tagList.map((t) => ({
      key: t.key, name: t.name, unit: t.unit || '', type: t.type,
      gateway: t.gateway, alarm: t.alarm || null,
    })),
  });
});

app.get('/api/snapshot', (_req, res) => res.json({ ts: Date.now(), data: snapshot }));

app.get('/api/history', (req, res) => {
  const key = req.query.key;
  const hours = Math.min(Number(req.query.hours) || 6, 24 * 30);
  if (!tagByKey[key]) return res.status(404).json({ error: 'unknown tag' });
  const since = Date.now() - hours * 3600_000;
  res.json(db.history(key, since));
});

app.get('/api/events', (_req, res) => res.json(db.recentEvents(50)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', ts: Date.now(), data: snapshot }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

server.listen(config.server.port, () => {
  console.log(`[baleen] dashboard on http://0.0.0.0:${config.server.port}`);
  console.log(`[baleen] polling ${config.gateways.length} gateways every ${config.pollIntervalMs} ms`);
  loop();
});

function shutdown() {
  console.log('\n[baleen] shutting down');
  try { db.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
