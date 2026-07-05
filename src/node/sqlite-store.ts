// Docs: docs/templates/inbound-inbox.md
// SQLite storage adapter for the Node runtime (Railway / Render / DO / Fly / Docker).
// better-sqlite3 is synchronous; the async MessageStore interface keeps it swappable with D1.

import Database from 'better-sqlite3';
import type { MessageStore, StoredMessage } from '../core/types.js';

type Row = {
  id: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  thread_id: string | null;
  spam: string | null;
  received_at: number;
};

const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  fromAddr: r.from_addr,
  toAddr: r.to_addr,
  subject: r.subject,
  text: r.text,
  html: r.html,
  threadId: r.thread_id,
  spam: r.spam,
  receivedAt: r.received_at,
});

export class SqliteStore implements MessageStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT,
      text TEXT,
      html TEXT,
      thread_id TEXT,
      spam TEXT,
      received_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS webhook_secrets (secret TEXT PRIMARY KEY)`);
  }

  async putSecret(secret: string): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO webhook_secrets (secret) VALUES (?)').run(secret);
  }

  async listSecrets(): Promise<string[]> {
    const rows = this.db.prepare('SELECT secret FROM webhook_secrets').all() as Array<{ secret: string }>;
    return rows.map((r) => r.secret);
  }

  async put(m: StoredMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages
         (id, from_addr, to_addr, subject, text, html, thread_id, spam, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.id, m.fromAddr, m.toAddr, m.subject, m.text, m.html, m.threadId, m.spam, m.receivedAt);
  }

  async list(limit = 100): Promise<StoredMessage[]> {
    const rows = this.db
      .prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(toMessage);
  }

  async get(id: string): Promise<StoredMessage | null> {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }
}
