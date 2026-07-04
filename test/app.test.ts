// Docs: docs/templates/inbound-inbox.md
// End-to-end tests over the shared app with an in-memory SQLite store and a stubbed
// mailer — the signature-verification path is exercised with real HMAC signatures
// (same scheme as the MailKite SDK: HMAC-SHA256(secret, "<t>.<rawBody>"), header
// "t=<ms>,v1=<hex>"). No network, no real sends.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { createApp } from '../src/core/app.js';
import type { Mailer } from '../src/core/types.js';
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

type SentMessage = Parameters<Mailer['send']>[0];

function makeApp(opts: { failSend?: boolean } = {}): { app: Hono; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (opts.failSend) throw new Error('boom');
      sent.push(message);
      return { id: 'msg_out_1', status: 'queued' };
    },
  };
  const app = createApp({ store: new SqliteStore(':memory:'), mailer, webhookSecret: SECRET });
  return { app, sent };
}

function postInbound(app: Hono, body: string, signature: string): Promise<Response> {
  return Promise.resolve(app.request('/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mailkite-signature': signature },
    body,
  }));
}

test('POST /inbound rejects a missing or forged signature', async () => {
  const { app } = makeApp();
  const body = JSON.stringify(EVENT);

  assert.equal((await postInbound(app, body, '')).status, 401);
  assert.equal((await postInbound(app, body, sign(body, 'whsec_wrong'))).status, 401);
  // Valid signature over different bytes (tampered body).
  assert.equal((await postInbound(app, body + ' ', sign(body))).status, 401);

  // Nothing was stored.
  const html = await (await app.request('/')).text();
  assert.match(html, /No mail yet/);
});

test('POST /inbound stores a signed email.received event and acks with replyOk', async () => {
  const { app } = makeApp();
  const body = JSON.stringify(EVENT);

  const res = await postInbound(app, body, sign(body));
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

test('POST /inbound is idempotent across webhook retries', async () => {
  const { app } = makeApp();
  const body = JSON.stringify(EVENT);
  await postInbound(app, body, sign(body));
  await postInbound(app, body, sign(body));

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

test('POST /reply sends via the SDK with addresses swapped and inReplyTo threading', async () => {
  const { app, sent } = makeApp();
  const body = JSON.stringify(EVENT);
  await postInbound(app, body, sign(body));

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
  const body = JSON.stringify(EVENT);
  await postInbound(app, body, sign(body));

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
