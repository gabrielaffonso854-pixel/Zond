import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    PRIMARY KEY (guild_id, setting_key)
  );
  CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    service TEXT NOT NULL,
    http_status INTEGER,
    error_type TEXT NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    request_id TEXT
  );
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    created_at TEXT NOT NULL,
    module TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS component_votes (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS published_panels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT PRIMARY KEY,
    panel_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const selectSetting = db.prepare(
  'SELECT setting_value FROM guild_settings WHERE guild_id = ? AND setting_key = ?',
);
const upsertSetting = db.prepare(`
  INSERT INTO guild_settings (guild_id, setting_key, setting_value)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value
`);

export function getSetting(guildId, key, fallback = null) {
  const row = selectSetting.get(guildId, key);
  if (!row) return fallback;
  return JSON.parse(row.setting_value);
}

export function setSetting(guildId, key, value) {
  upsertSetting.run(guildId, key, JSON.stringify(value));
}

export function getGuildSettings(guildId) {
  const rows = db.prepare(
    'SELECT setting_key, setting_value FROM guild_settings WHERE guild_id = ?',
  ).all(guildId);
  return Object.fromEntries(rows.map((row) => [row.setting_key, JSON.parse(row.setting_value)]));
}

export function storeError(error) {
  const insert = db.prepare(`
    INSERT INTO error_logs (created_at, service, http_status, error_type, step, message, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    error.createdAt,
    error.service,
    error.httpStatus ?? null,
    error.errorType,
    error.step,
    error.message,
    error.requestId ?? null,
  );
  db.exec(`
    DELETE FROM error_logs
    WHERE id NOT IN (SELECT id FROM error_logs ORDER BY id DESC LIMIT 200)
  `);
}

export function recentErrors(limit = 10) {
  return db.prepare(
    'SELECT created_at, service, http_status, error_type, step, message, request_id FROM error_logs ORDER BY id DESC LIMIT ?',
  ).all(Math.min(Math.max(limit, 1), 20));
}

export function storeSystemLog({ guildId, module, eventType, details }) {
  db.prepare(`
    INSERT INTO system_logs (guild_id, created_at, module, event_type, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId ?? null, new Date().toISOString(), module, eventType, JSON.stringify(details));
  db.exec(`
    DELETE FROM system_logs
    WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 5000)
  `);
}

export function recentSystemLogs(guildId, limit = 10) {
  return db.prepare(`
    SELECT created_at, module, event_type, details
    FROM system_logs
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(guildId, Math.min(Math.max(limit, 1), 20));
}

export function recordVote(guildId, messageId, userId, vote) {
  db.prepare(`
    INSERT INTO component_votes (guild_id, message_id, user_id, vote)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id) DO UPDATE SET vote = excluded.vote
  `).run(guildId, messageId, userId, vote);
  db.exec(`
    DELETE FROM component_votes
    WHERE rowid NOT IN (SELECT rowid FROM component_votes ORDER BY rowid DESC LIMIT 100000)
  `);
}

export function voteCounts(messageId) {
  const rows = db.prepare(
    'SELECT vote, COUNT(*) AS count FROM component_votes WHERE message_id = ? GROUP BY vote',
  ).all(messageId);
  return Object.fromEntries(rows.map((row) => [row.vote, row.count]));
}

export function recordPublishedPanel(guildId, channelId, messageId, panelType) {
  db.prepare(`
    INSERT OR REPLACE INTO published_panels (guild_id, channel_id, message_id, panel_type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, channelId, messageId, panelType, new Date().toISOString());
  db.exec(`
    DELETE FROM published_panels
    WHERE message_id NOT IN (SELECT message_id FROM published_panels ORDER BY created_at DESC LIMIT 1000)
  `);
  db.exec(`
    DELETE FROM component_votes
    WHERE message_id NOT IN (SELECT message_id FROM published_panels)
  `);
}

export function getPublishedPanel(guildId, messageId) {
  return db.prepare(`
    SELECT guild_id, channel_id, message_id, panel_type, created_at
    FROM published_panels WHERE guild_id = ? AND message_id = ?
  `).get(guildId, messageId);
}
