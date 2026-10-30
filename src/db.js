const path = require('path');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'sla.db');
let db;
try {
  // Preferred: better-sqlite3 (needs a prebuilt binary or build tools)
  const Database = require('better-sqlite3');
  db = new Database(file);
} catch (e) {
  // Fallback: Node's built-in SQLite (Node 22.5+). No installation or compiling needed.
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(file);
}
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY, priority TEXT UNIQUE NOT NULL,
  first_response_mins INTEGER NOT NULL, resolution_mins INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  customer_ref TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL,
  description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', agent_id INTEGER,
  created_at TEXT NOT NULL, resolution_start TEXT NOT NULL,
  first_response_at TEXT, resolved_at TEXT,
  response_due TEXT NOT NULL, resolution_due TEXT NOT NULL,
  paused_at TEXT, paused_total_mins REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ticket_history (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
  due_ref TEXT NOT NULL, message TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1, at TEXT NOT NULL
);
`);
module.exports = db;
