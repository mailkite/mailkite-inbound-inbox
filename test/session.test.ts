// Docs: docs/templates/inbound-inbox.md
// Pure session + PKCE helpers — no network, no cookies. The security-critical local primitives:
// session (de)serialization, expiry math, the open-redirect guard, and PKCE S256 derivation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { parseSession, parseTx, isExpired, safeReturnTo, serialize, type Session } from '../src/core/session.js';
import { pkce, randomState, redirectUri } from '../src/core/oauth.js';

const SESSION: Session = { accessToken: 'jwt.abc', refreshToken: 'mkr_x', expiresAt: 2_000_000, clientId: 'mkcli_1' };

test('parseSession round-trips a valid session and rejects junk', () => {
  assert.deepEqual(parseSession(serialize(SESSION)), SESSION);
  assert.equal(parseSession(undefined), null);
  assert.equal(parseSession('not json'), null);
  assert.equal(parseSession(JSON.stringify({ refreshToken: 'x' })), null);
});

test('parseTx requires verifier + state', () => {
  const tx = { verifier: 'v', state: 's', clientId: 'c', returnTo: '/x' };
  assert.deepEqual(parseTx(JSON.stringify(tx)), tx);
  assert.equal(parseTx(JSON.stringify({ state: 's' })), null);
  assert.equal(parseTx(undefined), null);
});

test('isExpired treats the last minute as expired (refresh early)', () => {
  const now = 1_000_000;
  assert.equal(isExpired({ ...SESSION, expiresAt: now + 5 * 60_000 }, now), false);
  assert.equal(isExpired({ ...SESSION, expiresAt: now + 30_000 }, now), true);
  assert.equal(isExpired({ ...SESSION, expiresAt: now - 1 }, now), true);
});

test('safeReturnTo only allows same-origin absolute paths (no open redirect)', () => {
  assert.equal(safeReturnTo('/messages/msg_1'), '/messages/msg_1');
  assert.equal(safeReturnTo('//evil.com'), '/');
  assert.equal(safeReturnTo('https://evil.com'), '/');
  assert.equal(safeReturnTo(null), '/');
  assert.equal(safeReturnTo(undefined), '/');
});

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('pkce challenge is base64url(SHA-256(verifier)), url-safe and unique', async () => {
  const a = await pkce();
  assert.match(a.verifier, /^[A-Za-z0-9\-_]+$/);
  assert.match(a.challenge, /^[A-Za-z0-9\-_]+$/);
  assert.equal(a.challenge, b64url(crypto.createHash('sha256').update(a.verifier).digest()));
  const b = await pkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(randomState(), randomState());
});

test('redirectUri is always this app\'s own callback', () => {
  assert.equal(redirectUri('https://my-inbox.example.com'), 'https://my-inbox.example.com/auth/callback');
});
