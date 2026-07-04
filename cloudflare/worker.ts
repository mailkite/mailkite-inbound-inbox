// Docs: docs/templates/inbound-inbox.md
// Cloudflare Workers entry — deployed by the "Deploy to Cloudflare" button (or `npm run cf:deploy`).

import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import type { Hono } from 'hono';
import { MailKite } from 'mailkite';
import { createApp } from '../src/core/app.js';
import { createMailKiteAuth } from '../src/core/auth.js';
import { D1Store } from './d1-store.js';

interface Env {
  DB: D1Database;
  MAILKITE_WEBHOOK_SECRET: string;
  /** Optional — override the OAuth issuer for local testing. Defaults to https://mcp.mailkite.dev. */
  MAILKITE_OAUTH_ISSUER?: string;
}

// Bindings are per-isolate constants, so build the app once and reuse it across requests.
let app: Hono | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // The ONLY required secret — sign-in is OAuth, so there's no API key here.
    if (!env.MAILKITE_WEBHOOK_SECRET) {
      return new Response(
        'Missing secret: set MAILKITE_WEBHOOK_SECRET ' +
          '(wrangler secret put MAILKITE_WEBHOOK_SECRET, or the Worker settings in the Cloudflare dashboard).',
        { status: 500 }
      );
    }
    app ??= createApp({
      store: new D1Store(env.DB),
      webhookSecret: env.MAILKITE_WEBHOOK_SECRET,
      auth: createMailKiteAuth({ issuer: env.MAILKITE_OAUTH_ISSUER }),
      clientFor: (accessToken) => {
        const mk = new MailKite(accessToken);
        return { send: (m) => mk.send(m), listDomains: () => mk.listDomains() as Promise<Array<{ domain: string }>> };
      },
    });
    return app.fetch(request, env, ctx as Parameters<Hono['fetch']>[2]);
  },
};
