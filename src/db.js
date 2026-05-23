import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'ollive.db');

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
    provider TEXT,
    model TEXT,
    message_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    request_id TEXT UNIQUE,
    provider TEXT,
    model TEXT,
    status TEXT CHECK(status IN ('pending','streaming','success','error','cancelled')),
    latency_ms REAL,
    time_to_first_token_ms REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    tokens_per_second REAL,
    cost_estimate REAL,
    input_preview TEXT,
    output_preview TEXT,
    pii_types_detected TEXT,
    pii_redacted INTEGER DEFAULT 0,
    error_message TEXT,
    error_code TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id);
  CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
`);

// Prepared statements
const stmts = {
  createSession: db.prepare(`INSERT INTO sessions (id, provider, model, title) VALUES (?, ?, ?, ?)`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  getAllSessions: db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`),
  addMessage: db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`),
  incrMessageCount: db.prepare(`UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = ?`),
  getMessages: db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`),
  insertLog: db.prepare(`
    INSERT INTO logs (session_id, request_id, provider, model, status, latency_ms, time_to_first_token_ms,
      input_tokens, output_tokens, total_tokens, tokens_per_second, cost_estimate,
      input_preview, output_preview, pii_types_detected, pii_redacted, error_message, error_code)
    VALUES (@session_id, @request_id, @provider, @model, @status, @latency_ms, @time_to_first_token_ms,
      @input_tokens, @output_tokens, @total_tokens, @tokens_per_second, @cost_estimate,
      @input_preview, @output_preview, @pii_types_detected, @pii_redacted, @error_message, @error_code)
  `),
  updateSessionTotals: db.prepare(`
    UPDATE sessions SET total_tokens = total_tokens + ?, total_cost = total_cost + ?, updated_at = datetime('now') WHERE id = ?
  `),
  getRecentLogs: db.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT ?`),
  getLogsBySession: db.prepare(`SELECT * FROM logs WHERE session_id = ? ORDER BY created_at DESC`),
};

export function getDb() { return db; }

export function createSession(id, provider, model, title = 'New Chat') {
  stmts.createSession.run(id, provider, model, title);
}

export function getSession(id) {
  return stmts.getSession.get(id);
}

export function getAllSessions() {
  return stmts.getAllSessions.all();
}

export function updateSession(id, fields) {
  const allowed = ['title', 'status', 'provider', 'model', 'message_count', 'total_tokens', 'total_cost'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function addMessage(sessionId, role, content) {
  stmts.addMessage.run(sessionId, role, content);
  stmts.incrMessageCount.run(sessionId);
}

export function getMessages(sessionId, limit = 20) {
  return stmts.getMessages.all(sessionId, limit);
}

export function insertLog(logData) {
  stmts.insertLog.run(logData);
  if (logData.session_id && logData.total_tokens) {
    stmts.updateSessionTotals.run(logData.total_tokens || 0, logData.cost_estimate || 0, logData.session_id);
  }
}

export function getRecentLogs(limit = 50) {
  return stmts.getRecentLogs.all(limit);
}

export function getLogsBySession(sessionId) {
  return stmts.getLogsBySession.all(sessionId);
}
