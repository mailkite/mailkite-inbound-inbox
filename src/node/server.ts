// Docs: docs/templates/inbound-inbox.md
// Node entry — Railway / Render / DigitalOcean / Fly / Docker / `npm run dev`.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { MailKite } from 'mailkite';
import { createApp } from '../core/app.js';
import { createMailKiteAuth } from '../core/auth.js';
import { SqliteStore } from './sqlite-store.js';

// Optional — connecting a domain caches that route's own per-route signing secret, so no env secret
// is needed. Set it only to verify with the account-wide secret or before anyone has connected.
const webhookSecret = process.env.MAILKITE_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.warn('No MAILKITE_WEBHOOK_SECRET set — inbound verifies against per-route secrets cached when you Connect a domain (sign in and click Connect after deploy).');
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
      listDomains: () => mk.listDomains() as Promise<Array<{ id: string; domain: string }>>,
      listRoutes: () =>
        mk.listRoutes() as Promise<Array<{ match_pattern: string; action: string; destination: string | null }>>,
      setWebhook: (id, body) => mk.setWebhook(id, body) as Promise<{ signingSecret?: string }>,
      createRoute: (body) => mk.createRoute(body) as Promise<{ signing_secret?: string | null }>,
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Inbound Inbox listening on http://localhost:${port}`);
  console.log(`Webhook endpoint: POST /inbound · storage: ${dbPath}`);
});
