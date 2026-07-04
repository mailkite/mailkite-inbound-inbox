// Docs: docs/templates/inbound-inbox.md
// Cloudflare Workers entry — deployed by the "Deploy to Cloudflare" button (or `npm run cf:deploy`).

import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import type { Hono } from 'hono';
import { MailKite } from 'mailkite';
import { createApp } from '../src/core/app.js';
import { D1Store } from './d1-store.js';

interface Env {
  DB: D1Database;
  MAILKITE_API_KEY: string;
  MAILKITE_WEBHOOK_SECRET: string;
}

// Bindings are per-isolate constants, so build the app once and reuse it across requests.
let app: Hono | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!env.MAILKITE_API_KEY || !env.MAILKITE_WEBHOOK_SECRET) {
      return new Response(
        'Missing secrets: set MAILKITE_API_KEY and MAILKITE_WEBHOOK_SECRET ' +
          '(wrangler secret put …, or the Worker settings in the Cloudflare dashboard).',
        { status: 500 }
      );
    }
    app ??= createApp({
      store: new D1Store(env.DB),
      mailer: new MailKite(env.MAILKITE_API_KEY),
      webhookSecret: env.MAILKITE_WEBHOOK_SECRET,
    });
    return app.fetch(request, env, ctx as Parameters<Hono['fetch']>[2]);
  },
};
