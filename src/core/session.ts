// Docs: docs/templates/inbound-inbox.md
// The signed-in session — stored entirely in cookies (no database of its own). The access token
// IS a MailKite-signed JWT, so a visitor can't forge one; the cookie needs no signing secret of
// ours. Pure helpers only (serialize/parse/expiry) — the actual cookie read/write uses hono/cookie
// at the call sites in auth.ts.

export const SESSION_COOKIE = "mk_session";
export const TX_COOKIE = "mk_oauth_tx";

export interface Session {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch when the access token expires. */
  expiresAt: number;
  clientId: string;
}

export interface TxState {
  verifier: string;
  state: string;
  clientId: string;
  returnTo: string;
}

export const serialize = (v: Session | TxState): string => JSON.stringify(v);

export function parseSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Session;
    return typeof v?.accessToken === "string" && typeof v?.clientId === "string" ? v : null;
  } catch {
    return null;
  }
}

export function parseTx(raw: string | undefined): TxState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as TxState;
    return typeof v?.verifier === "string" && typeof v?.state === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Expired a minute early, so a refresh happens before the API 401s. */
export const isExpired = (s: Session, now = Date.now()): boolean => s.expiresAt - 60_000 <= now;

/** Only same-origin, path-absolute return targets (never an open redirect). */
export const safeReturnTo = (value: string | null | undefined): string =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
