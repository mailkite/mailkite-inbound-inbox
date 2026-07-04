// Docs: docs/templates/inbound-inbox.md
// The app itself — shared by both runtimes (Node + SQLite, Workers + D1).
// Routes: GET / (inbox) · GET /messages/:id · POST /inbound (webhook) · POST /reply.

import { Hono } from 'hono';
import { MailKite, MailKiteError } from 'mailkite';
import { toStoredMessage } from './inbound.js';
import type { InboundEvent, Mailer, MessageStore } from './types.js';
import { InboxPage, MessagePage, NotFoundPage } from './ui.js';

export interface AppDeps {
  store: MessageStore;
  /** A `new MailKite(apiKey)` client — or a stub in tests. */
  mailer: Mailer;
  /** Webhook signing secret from the MailKite dashboard (whsec_…). */
  webhookSecret: string;
}

export function createApp({ store, mailer, webhookSecret }: AppDeps): Hono {
  const app = new Hono();

  // --- Inbox UI --------------------------------------------------------------
  app.get('/', async (c) => c.html(<InboxPage messages={await store.list()} />));

  app.get('/messages/:id', async (c) => {
    const msg = await store.get(c.req.param('id'));
    if (!msg) return c.html(<NotFoundPage />, 404);
    const sent = c.req.query('sent') === '1';
    const error = c.req.query('error') || undefined;
    return c.html(<MessagePage msg={msg} sent={sent} error={error} />);
  });

  // --- MailKite webhook receiver ----------------------------------------------
  app.post('/inbound', async (c) => {
    // Verify against the RAW body bytes — parsed-and-re-serialized JSON breaks the HMAC.
    const raw = await c.req.text();
    const signature = c.req.header('x-mailkite-signature') ?? '';
    if (!MailKite.verifyWebhook(signature, raw, webhookSecret)) {
      return c.text('bad signature', 401);
    }

    const event = JSON.parse(raw) as InboundEvent;
    if (event.type === 'email.received') {
      await store.put(toStoredMessage(event));
    }

    // Acknowledge with the SDK's canonical ack body: {"status":"ok"}.
    return c.body(MailKite.replyOk(), 200, { 'Content-Type': 'application/json' });
  });

  // --- Reply -------------------------------------------------------------------
  app.post('/reply', async (c) => {
    const form = await c.req.parseBody();
    const id = typeof form.id === 'string' ? form.id : '';
    const body = typeof form.body === 'string' ? form.body.trim() : '';
    const msg = await store.get(id);
    if (!msg) return c.html(<NotFoundPage />, 404);
    const back = `/messages/${encodeURIComponent(msg.id)}`;
    if (!body) return c.redirect(`${back}?error=${encodeURIComponent('empty reply')}`);

    try {
      await mailer.send({
        // Reply from the address the mail was sent to — it's on your verified domain.
        from: msg.toAddr,
        to: msg.fromAddr,
        subject: msg.subject?.match(/^re:/i) ? msg.subject : `Re: ${msg.subject ?? ''}`.trim(),
        text: body,
        // threadId is the thread-root Message-ID MailKite extracted — passing it as
        // inReplyTo keeps the reply in the same thread in the recipient's client.
        inReplyTo: msg.threadId ?? undefined,
      });
      return c.redirect(`${back}?sent=1`);
    } catch (e) {
      const detail = e instanceof MailKiteError ? e.message : 'send failed';
      return c.redirect(`${back}?error=${encodeURIComponent(detail)}`);
    }
  });

  // --- Health check (Render / Railway / DO) ------------------------------------
  app.get('/healthz', (c) => c.text('ok'));

  return app;
}
