// Docs: docs/templates/inbound-inbox.md
// D1 storage adapter for the Cloudflare Workers runtime. The table is created lazily on
// first use so the "Deploy to Cloudflare" button needs no migration step.

import type { D1Database } from '@cloudflare/workers-types';
import type { MessageStore, StoredMessage } from '../src/core/types.js';

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

export class D1Store implements MessageStore {
  private ready: Promise<unknown> | undefined;

  constructor(private db: D1Database) {}

  private init(): Promise<unknown> {
    // D1 `exec` splits statements on newlines, so run the two CREATEs as separate calls.
    this.ready ??= (async () => {
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          from_addr TEXT NOT NULL,
          to_addr TEXT NOT NULL,
          subject TEXT,
          text TEXT,
          html TEXT,
          thread_id TEXT,
          spam TEXT,
          received_at INTEGER NOT NULL
        )`.replace(/\s+/g, ' ')
      );
      await this.db.exec('CREATE TABLE IF NOT EXISTS webhook_secrets (secret TEXT PRIMARY KEY)');
    })();
    return this.ready;
  }

  async putSecret(secret: string): Promise<void> {
    await this.init();
    await this.db.prepare('INSERT OR IGNORE INTO webhook_secrets (secret) VALUES (?)').bind(secret).run();
  }

  async listSecrets(): Promise<string[]> {
    await this.init();
    const { results } = await this.db.prepare('SELECT secret FROM webhook_secrets').all<{ secret: string }>();
    return results.map((r) => r.secret);
  }

  async put(m: StoredMessage): Promise<void> {
    await this.init();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO messages
         (id, from_addr, to_addr, subject, text, html, thread_id, spam, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(m.id, m.fromAddr, m.toAddr, m.subject, m.text, m.html, m.threadId, m.spam, m.receivedAt)
      .run();
  }

  async list(limit = 100): Promise<StoredMessage[]> {
    await this.init();
    const { results } = await this.db
      .prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT ?')
      .bind(limit)
      .all<Row>();
    return results.map(toMessage);
  }

  async get(id: string): Promise<StoredMessage | null> {
    await this.init();
    const row = await this.db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<Row>();
    return row ? toMessage(row) : null;
  }
}
