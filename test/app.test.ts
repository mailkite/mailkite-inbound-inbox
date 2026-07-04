// Docs: docs/templates/inbound-inbox.md
// End-to-end tests over the shared app with an in-memory SQLite store. Auth is injected as a fake
// (no real OAuth / network): `resolve` returns a signed-in user, `clientFor` returns a stub that
// records sends and reports the owned domains. The webhook signature path is exercised with real
// HMAC signatures (HMAC-SHA256(secret, "<t>.<rawBody>"), header "t=<ms>,v1=<hex>").

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { createApp } from '../src/core/app.js';
import type { ApiClient, Auth } from '../src/core/types.js';
import { SqliteStore } from '../src/node/sqlite-store.js';

const SECRET = 'whsec_mailkite_test';

function sign(body: string, secret = SECRET, t = Date.now()): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const EVENT = {
  id: 'msg_test_1',
  type: 'email.received',
  from: { address: 'ada@example.com' },
  to: [{ address: 'inbox@myapp.dev' }],
  subject: 'Hello there',
  text: 'Does the inbox work?',
  html: '<p>Does the inbox work?</p>',
  threadId: '<root-message-id@example.com>',
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam: 'ham' },
  attachments: [],
};

type SentMessage = Parameters<ApiClient['send']>[0];

function makeApp(opts: { failSend?: boolean; signedIn?: boolean; domains?: string[] } = {}): {
  app: Hono;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const client: ApiClient = {
    async send(message) {
      if (opts.failSend) throw new Error('boom');
      sent.push(message);
      return { id: 'msg_out_1', status: 'queued' };
    },
    async listDomains() {
      return (opts.domains ?? ['myapp.dev']).map((domain) => ({ domain }));
    },
  };
  const auth: Auth = {
    async resolve() {
      return opts.signedIn === false ? null : { accessToken: 'tok_test' };
    },
    login: (c) => c.redirect('/auth/login-stub'),
    callback: (c) => c.redirect('/'),
    logout: (c) => c.redirect('/'),
  };
  const app = createApp({ store: new SqliteStore(':memory:'), webhookSecret: SECRET, auth, clientFor: () => client });
  return { app, sent };
}

function postInbound(app: Hono, body: string, signature: string): Promise<Response> {
  return Promise.resolve(
    app.request('/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mailkite-signature': signature },
      body,
    }),
  );
}

async function store(app: Hono): Promise<void> {
  const body = JSON.stringify(EVENT);
  await postInbound(app, body, sign(body));
}

test('the inbox and a message require sign-in (redirect to /auth/login)', async () => {
  const { app } = makeApp({ signedIn: false });
  await store(app); // webhook is public, so it still stores

  const inbox = await app.request('/');
  assert.equal(inbox.status, 302);
  assert.match(inbox.headers.get('location') ?? '', /^\/auth\/login/);

  const msg = await app.request('/messages/msg_test_1');
  assert.equal(msg.status, 302);
  assert.match(msg.headers.get('location') ?? '', /^\/auth\/login/);
});

test('the webhook is public (no sign-in) — rejects a forged signature', async () => {
  const { app } = makeApp({ signedIn: false });
  const body = JSON.stringify(EVENT);

  assert.equal((await postInbound(app, body, '')).status, 401);
  assert.equal((await postInbound(app, body, sign(body, 'whsec_wrong'))).status, 401);
  assert.equal((await postInbound(app, body + ' ', sign(body))).status, 401);
});

test('POST /inbound stores a signed email.received event and acks with replyOk', async () => {
  const { app } = makeApp();
  const res = await postInbound(app, JSON.stringify(EVENT), sign(JSON.stringify(EVENT)));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"status":"ok"}'); // MailKite.replyOk()

  const inbox = await (await app.request('/')).text();
  assert.match(inbox, /ada@example\.com/);
  assert.match(inbox, /Hello there/);
  assert.match(inbox, /Does the inbox work\?/);

  const view = await app.request('/messages/msg_test_1');
  assert.equal(view.status, 200);
  assert.match(await view.text(), /inbox@myapp\.dev/);
});

test("the store is scoped to the signed-in user — mail for a domain you don't own is hidden", async () => {
  const { app } = makeApp({ domains: ['someone-else.dev'] }); // signed in, but does NOT own myapp.dev
  await store(app);

  const inbox = await (await app.request('/')).text();
  assert.match(inbox, /No mail yet/);

  const view = await app.request('/messages/msg_test_1');
  assert.equal(view.status, 404); // "not found", never revealing it exists
});

test('POST /inbound is idempotent across webhook retries', async () => {
  const { app } = makeApp();
  await store(app);
  await store(app);
  const inbox = await (await app.request('/')).text();
  assert.equal(inbox.match(/Hello there/g)?.length, 1);
});

test('POST /inbound acks but does not store other event types', async () => {
  const { app } = makeApp();
  const body = JSON.stringify({ ...EVENT, type: 'email.test' });
  const res = await postInbound(app, body, sign(body));
  assert.equal(res.status, 200);
  const inbox = await (await app.request('/')).text();
  assert.match(inbox, /No mail yet/);
});

test("POST /reply sends via the signed-in user's client with addresses swapped + inReplyTo", async () => {
  const { app, sent } = makeApp();
  await store(app);

  const res = await app.request('/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: 'msg_test_1', body: 'Yes — it works!' }).toString(),
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/messages/msg_test_1?sent=1');

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    from: 'inbox@myapp.dev',
    to: 'ada@example.com',
    subject: 'Re: Hello there',
    text: 'Yes — it works!',
    inReplyTo: '<root-message-id@example.com>',
  });
});

test('POST /reply surfaces a send failure without crashing', async () => {
  const { app } = makeApp({ failSend: true });
  await store(app);

  const res = await app.request('/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: 'msg_test_1', body: 'hi' }).toString(),
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /error=/);
});

test('POST /reply 404s for an unknown message id', async () => {
  const { app } = makeApp();
  const res = await app.request('/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: 'msg_nope', body: 'hi' }).toString(),
  });
  assert.equal(res.status, 404);
});
