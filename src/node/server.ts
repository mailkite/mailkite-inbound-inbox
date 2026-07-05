// Docs: docs/templates/inbound-inbox.md
// Node entry — Railway / Render / DigitalOcean / Fly / Docker / `npm run dev`.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { MailKite } from 'mailkite';
import { createApp } from '../core/app.js';
import { createMailKiteAuth } from '../core/auth.js';
import { SqliteStore } from './sqlite-store.js';

// The ONLY required secret — sign-in is OAuth, so there's no API key here (see .env.example).
const webhookSecret = process.env.MAILKITE_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error('Missing env: set MAILKITE_WEBHOOK_SECRET (see .env.example).');
  process.exit(1);
}

const dbPath = resolve(process.env.DATABASE_PATH ?? './data/inbox.db');
mkdirSync(dirname(dbPath), { recursive: true });

const app = createApp({
  store: new SqliteStore(dbPath),
  webhookSecret,
  auth: createMailKiteAuth({ issuer: process.env.MAILKITE_OAUTH_ISSUER }),
  clientFor: (accessToken) => {
    const mk = new MailKite(accessToken);
    return {
      send: (m) => mk.send(m),
      listDomains: () =>
        mk.listDomains() as Promise<Array<{ id: string; domain: string; webhookUrl: string | null }>>,
      setWebhook: (id, body) => mk.setWebhook(id, body),
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Inbound Inbox listening on http://localhost:${port}`);
  console.log(`Webhook endpoint: POST /inbound · storage: ${dbPath}`);
});
