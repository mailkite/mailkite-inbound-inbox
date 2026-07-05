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

type OwnedDomain = { id: string; domain: string };
type Vars = { client: ApiClient; ownedDomains: Set<string>; ownedDomainList: OwnedDomain[] };

const domainOf = (addr: string): string => addr.split('@').pop()?.toLowerCase() ?? '';

// Does a route's match pattern belong to this domain? (`*@domain`, `inbox@domain`, `gabe@domain`, …)
const routeInDomain = (pattern: string, domain: string): boolean =>
  pattern.toLowerCase().endsWith(`@${domain.toLowerCase()}`);

// This deployment's own public origin, derived from the request so it's correct on every host
// (Railway/Render/Fly/CF all sit behind a TLS proxy — honor x-forwarded-proto, don't assume the
// internal http). Used to point a domain's webhook back at us and to detect "already connected".
function selfInboundUrl(c: Context): string {
  const proto =
    (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim() ||
    new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}/inbound`;
}

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
  app.use('/connect', gate);

  async function gate(c: Context<{ Variables: Vars }>, next: Next): Promise<Response | void> {
    const user = await auth.resolve(c);
    if (!user) {
      const url = new URL(c.req.url);
      const returnTo = c.req.method === 'GET' ? url.pathname + url.search : '/';
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const client = clientFor(user.accessToken);
    let domains: OwnedDomain[];
    try {
      domains = await client.listDomains();
    } catch {
      // Token rejected (revoked/expired grant) → clear it and re-authorize.
      return c.redirect('/auth/logout');
    }
    c.set('client', client);
    c.set('ownedDomainList', domains);
    c.set('ownedDomains', new Set(domains.map((d) => d.domain.toLowerCase())));
    await next();
  }

  // --- Inbox UI (scoped to the signed-in user's domains) ---------------------
  app.get('/', async (c) => {
    const owned = c.get('ownedDomains');
    const self = selfInboundUrl(c);
    const routes = await c.get('client').listRoutes();
    const domains = c.get('ownedDomainList').map((d) => {
      const mine = routes.filter((r) => routeInDomain(r.match_pattern, d.domain));
      return {
        id: d.id,
        domain: d.domain,
        // Already sending mail here? (a `*@domain` or `inbox@domain` webhook route → us)
        connected: mine.some((r) => r.action === 'webhook' && r.destination === self),
        // A domain with no routes at all is safe to capture wholesale; otherwise we add `inbox@`.
        empty: mine.length === 0,
      };
    });
    const messages = (await store.list()).filter((m) => owned.has(domainOf(m.toAddr)));
    return c.html(
      <InboxPage
        messages={messages}
        domains={domains}
        selfInbound={self}
        connected={c.req.query('connected') || undefined}
        error={c.req.query('error') || undefined}
      />,
    );
  });

  // --- One-click connect: route a domain's mail to THIS deployment, WITHOUT clobbering -------
  // Acts as the signed-in user (their OAuth token — never a stored API key), only for a domain they
  // own. Crucially it never overwrites an existing catch-all / default webhook:
  //   • domain has NO routes at all → set the `*@domain` catch-all (safe: nothing to disturb).
  //   • domain already has routes    → ADD a specific `inbox@domain` webhook route (fan-out; the
  //     user's existing default webhook, forwards, and agent routes keep working untouched).
  // Idempotent: if a webhook route to us already exists, it's a no-op.
  app.post('/connect', async (c) => {
    const form = await c.req.parseBody();
    const domainId = typeof form.domainId === 'string' ? form.domainId : '';
    const target = c.get('ownedDomainList').find((d) => d.id === domainId);
    if (!target) return c.html(<NotFoundPage />, 404); // not yours / unknown → don't reveal

    const client = c.get('client');
    const self = selfInboundUrl(c);
    try {
      const mine = (await client.listRoutes()).filter((r) => routeInDomain(r.match_pattern, target.domain));
      const already = mine.some((r) => r.action === 'webhook' && r.destination === self);
      if (!already) {
        if (mine.length === 0) {
          await client.setWebhook(target.id, { url: self }); // empty domain → full catch-all
        } else {
          // Domain already routes mail — don't touch the default; add a dedicated address instead.
          await client.createRoute({ match: `inbox@${target.domain}`, action: 'webhook', destination: self });
        }
      }
      return c.redirect(`/?connected=${encodeURIComponent(target.domain)}`);
    } catch (e) {
      const detail = e instanceof MailKiteError ? e.message : 'could not connect the domain';
      return c.redirect(`/?error=${encodeURIComponent(detail)}`);
    }
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
