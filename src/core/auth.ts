// Docs: docs/templates/inbound-inbox.md
// The production Auth implementation: MailKite OAuth 2.1 + PKCE over cookies, portable across the
// Node and Cloudflare Workers runtimes (hono/cookie + Web Crypto + fetch, no Node-only APIs).
//   • login    → self-register a client for this origin, mint PKCE + state, 302 to consent
//   • callback → verify state, exchange the code, drop the session cookie, land back where we were
//   • logout   → revoke the refresh token, clear the cookie
//   • resolve  → read the session cookie for one request, refreshing the access token when stale

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Auth, SignedIn } from './types.js';
import { OAuth, pkce, randomState, DEFAULT_ISSUER } from './oauth.js';
import {
  SESSION_COOKIE, TX_COOKIE, serialize, parseSession, parseTx, isExpired, safeReturnTo, type Session,
} from './session.js';

const originOf = (c: Context): string => new URL(c.req.url).origin;
const isHttps = (c: Context): boolean => new URL(c.req.url).protocol === 'https:';

const sessionCookieOpts = (c: Context) =>
  ({ httpOnly: true, secure: isHttps(c), sameSite: 'Lax' as const, path: '/', maxAge: 60 * 24 * 60 * 60 });
const txCookieOpts = (c: Context) =>
  ({ httpOnly: true, secure: isHttps(c), sameSite: 'Lax' as const, path: '/', maxAge: 10 * 60 });

function writeSession(c: Context, s: Session): void {
  setCookie(c, SESSION_COOKIE, serialize(s), sessionCookieOpts(c));
}

export function createMailKiteAuth(opts: { issuer?: string } = {}): Auth {
  const oauth = new OAuth(opts.issuer ?? DEFAULT_ISSUER);

  return {
    async login(c) {
      const origin = originOf(c);
      const returnTo = safeReturnTo(c.req.query('returnTo'));
      try {
        const clientId = await oauth.registerClient(origin);
        const { verifier, challenge } = await pkce();
        const state = randomState();
        setCookie(c, TX_COOKIE, serialize({ verifier, state, clientId, returnTo }), txCookieOpts(c));
        return c.redirect(await oauth.authorizeUrl(origin, clientId, challenge, state));
      } catch (e) {
        return c.text(`Sign-in with MailKite is unavailable: ${e instanceof Error ? e.message : 'error'}`, 502);
      }
    },

    async callback(c) {
      const err = c.req.query('error');
      if (err) {
        deleteCookie(c, TX_COOKIE);
        return c.text(`Sign-in failed: ${err === 'access_denied' ? "you didn't authorize access" : err}`, 400);
      }
      const tx = parseTx(getCookie(c, TX_COOKIE));
      deleteCookie(c, TX_COOKIE);
      if (!tx) return c.text('Sign-in failed: your sign-in session expired — please try again', 400);

      const code = c.req.query('code');
      const state = c.req.query('state');
      if (!code || !state) return c.text('Sign-in failed: missing code or state', 400);
      if (state !== tx.state) return c.text('Sign-in failed: state mismatch — possible CSRF, aborted', 400);

      try {
        const t = await oauth.exchangeCode({ code, verifier: tx.verifier, origin: originOf(c), clientId: tx.clientId });
        writeSession(c, {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + t.expires_in * 1000,
          clientId: tx.clientId,
        });
        return c.redirect(safeReturnTo(tx.returnTo));
      } catch (e) {
        return c.text(`Sign-in failed: ${e instanceof Error ? e.message : 'token exchange failed'}`, 502);
      }
    },

    async logout(c) {
      const session = parseSession(getCookie(c, SESSION_COOKIE));
      if (session?.refreshToken) await oauth.revokeToken(session.refreshToken);
      deleteCookie(c, SESSION_COOKIE);
      return c.redirect('/');
    },

    async resolve(c): Promise<SignedIn | null> {
      const session = parseSession(getCookie(c, SESSION_COOKIE));
      if (!session) return null;
      if (!isExpired(session)) return { accessToken: session.accessToken };
      if (!session.refreshToken) {
        deleteCookie(c, SESSION_COOKIE);
        return null;
      }
      try {
        const t = await oauth.refreshTokens({ refreshToken: session.refreshToken, clientId: session.clientId });
        const next: Session = {
          accessToken: t.access_token,
          refreshToken: t.refresh_token ?? session.refreshToken,
          expiresAt: Date.now() + t.expires_in * 1000,
          clientId: session.clientId,
        };
        writeSession(c, next);
        return { accessToken: next.accessToken };
      } catch {
        deleteCookie(c, SESSION_COOKIE);
        return null;
      }
    },
  };
}
