// Docs: docs/templates/inbound-inbox.md
// Node entry — Railway / Render / DigitalOcean / Fly / Docker / `npm run dev`.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { MailKite } from 'mailkite';
import { createApp } from '../core/app.js';
import { SqliteStore } from './sqlite-store.js';

const apiKey = process.env.MAILKITE_API_KEY;
const webhookSecret = process.env.MAILKITE_WEBHOOK_SECRET;
if (!apiKey || !webhookSecret) {
  console.error(
    'Missing env: set MAILKITE_API_KEY and MAILKITE_WEBHOOK_SECRET (see .env.example).'
  );
  process.exit(1);
}

const dbPath = resolve(process.env.DATABASE_PATH ?? './data/inbox.db');
mkdirSync(dirname(dbPath), { recursive: true });

const app = createApp({
  store: new SqliteStore(dbPath),
  mailer: new MailKite(apiKey),
  webhookSecret,
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Inbound Inbox listening on http://localhost:${port}`);
  console.log(`Webhook endpoint: POST /inbound · storage: ${dbPath}`);
});
