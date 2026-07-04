// Docs: docs/templates/inbound-inbox.md
// The app itself — shared by both runtimes (Node + SQLite, Workers + D1).
// Routes: GET / (inbox) · GET /messages/:id · POST /reply · GET /auth/{login,callback,logout}
//         · POST /inbound (webhook) · GET /healthz
//
// PRIVATE by design: the inbox is a PUBLIC URL, so the UI + reply routes are gated behind
// MailKite OAuth. There's no shared API key — each request acts as the signed-in user via their
// OAuth access token, and the shared store is scoped to the domains THAT user owns (so one
// account can never read another's mail). The webhook stays public (MailKite signs it).

import { Hono, type Context, type Next } from 'hono';
import { MailKite, MailKiteError } from 'mailkite';
import { toStoredMessage } from './inbound.js';
import type { ApiClient, Auth, InboundEvent, MessageStore } from './types.js';
import { InboxPage, MessagePage, NotFoundPage } from './ui.js';

export interface AppDeps {
  store: MessageStore;
  /** Webhook signing secret from the MailKite dashboard (whsec_…). */
  webhookSecret: string;
  /** Authentication seam — production wires MailKite OAuth (`createMailKiteAuth`); tests stub it. */
  auth: Auth;
  /** Build an API client for a signed-in user's access token. Production: `(t) => new MailKite(t)`. */
  clientFor: (accessToken: string) => ApiClient;
}

type Vars = { client: ApiClient; ownedDomains: Set<string> };

const domainOf = (addr: string): string => addr.split('@').pop()?.toLowerCase() ?? '';

export function createApp({ store, webhookSecret, auth, clientFor }: AppDeps): Hono {
  const app = new Hono<{ Variables: Vars }>();

  // --- Auth handshake (public) -----------------------------------------------
  app.get('/auth/login', (c) => auth.login(c));
  app.get('/auth/callback', (c) => auth.callback(c));
  app.get('/auth/logout', (c) => auth.logout(c));

  // --- Gate: the inbox UI + reply require a signed-in user -------------------
  app.use('/', gate);
  app.use('/messages/*', gate);
  app.use('/reply', gate);

  async function gate(c: Context<{ Variables: Vars }>, next: Next): Promise<Response | void> {
    const user = await auth.resolve(c);
    if (!user) {
      const url = new URL(c.req.url);
      const returnTo = c.req.method === 'GET' ? url.pathname + url.search : '/';
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const client = clientFor(user.accessToken);
    let domains: Array<{ domain: string }>;
    try {
      domains = await client.listDomains();
    } catch {
      // Token rejected (revoked/expired grant) → clear it and re-authorize.
      return c.redirect('/auth/logout');
    }
    c.set('client', client);
    c.set('ownedDomains', new Set(domains.map((d) => d.domain.toLowerCase())));
    await next();
  }

  // --- Inbox UI (scoped to the signed-in user's domains) ---------------------
  app.get('/', async (c) => {
    const owned = c.get('ownedDomains');
    const messages = (await store.list()).filter((m) => owned.has(domainOf(m.toAddr)));
    return c.html(<InboxPage messages={messages} />);
  });

  app.get('/messages/:id', async (c) => {
    const msg = await store.get(c.req.param('id'));
    // Treat mail for a domain you don't own as "not found" — don't reveal it exists.
    if (!msg || !c.get('ownedDomains').has(domainOf(msg.toAddr))) return c.html(<NotFoundPage />, 404);
    const sent = c.req.query('sent') === '1';
    const error = c.req.query('error') || undefined;
    return c.html(<MessagePage msg={msg} sent={sent} error={error} />);
  });

  // --- MailKite webhook receiver (public — MailKite signs it) ----------------
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

  // --- Reply (as the signed-in user) -----------------------------------------
  app.post('/reply', async (c) => {
    const form = await c.req.parseBody();
    const id = typeof form.id === 'string' ? form.id : '';
    const body = typeof form.body === 'string' ? form.body.trim() : '';
    const msg = await store.get(id);
    if (!msg || !c.get('ownedDomains').has(domainOf(msg.toAddr))) return c.html(<NotFoundPage />, 404);
    const back = `/messages/${encodeURIComponent(msg.id)}`;
    if (!body) return c.redirect(`${back}?error=${encodeURIComponent('empty reply')}`);

    try {
      await c.get('client').send({
        // Reply from the address the mail was sent to — it's on a domain you own.
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

  // --- Health check (Render / Railway / DO) — public ---------------------------
  app.get('/healthz', (c) => c.text('ok'));

  // The `Variables` generic is an internal detail (gate → handler plumbing); callers only need a
  // plain Hono to `.fetch()` / `.request()`.
  return app as unknown as Hono;
}
