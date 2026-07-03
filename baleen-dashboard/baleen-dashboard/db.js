'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

function openDb(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode = WAL;'); // better for continuous writes + concurrent reads
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      ts    INTEGER NOT NULL,
      tkey  TEXT    NOT NULL,
      value REAL
    );
    CREATE INDEX IF NOT EXISTS idx_readings_key_ts ON readings (tkey, ts);

    CREATE TABLE IF NOT EXISTS events (
      ts      INTEGER NOT NULL,
      tkey    TEXT    NOT NULL,
      state   TEXT    NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  `);

  const insertReading = db.prepare('INSERT INTO readings (ts, tkey, value) VALUES (?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO events (ts, tkey, state, message) VALUES (?, ?, ?, ?)');
  const historyStmt = db.prepare('SELECT ts, value FROM readings WHERE tkey = ? AND ts >= ? ORDER BY ts ASC');
  const recentEventsStmt = db.prepare('SELECT ts, tkey, state, message FROM events ORDER BY ts DESC LIMIT ?');
  const pruneStmt = db.prepare('DELETE FROM readings WHERE ts < ?');

  return {
    writeReadings(rows) {
      if (!rows.length) return;
      db.exec('BEGIN');
      try {
        for (const r of rows) insertReading.run(r.ts, r.tkey, r.value);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    writeEvent(ts, tkey, state, message) { insertEvent.run(ts, tkey, state, message); },
    history(tkey, sinceMs) { return historyStmt.all(tkey, sinceMs); },
    recentEvents(limit = 50) { return recentEventsStmt.all(limit); },
    prune(retentionDays) { pruneStmt.run(Date.now() - retentionDays * 86400000); },
    close() { db.close(); },
  };
}

module.exports = { openDb };
