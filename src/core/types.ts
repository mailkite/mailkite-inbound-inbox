// Docs: docs/templates/inbound-inbox.md
// Shared contract between the webhook receiver, the storage adapters, and the UI.
import type { Context } from 'hono';

/** The `email.received` event MailKite POSTs to your webhook. */
export interface InboundEvent {
  id: string;
  type: string;
  from: { address: string };
  to: Array<{ address: string }>;
  subject: string | null;
  text: string | null;
  html: string | null;
  threadId: string | null;
  auth: { spf: string | null; dkim: string | null; dmarc: string | null; spam: string | null };
  attachments: Array<{
    id?: string;
    filename: string | null;
    contentType: string | null;
    size: number;
    url?: string;
  }>;
}

/** One row in the inbox — what we persist from each inbound event. */
export interface StoredMessage {
  id: string;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  /** Thread root Message-ID from MailKite — passed back as `inReplyTo` when replying. */
  threadId: string | null;
  /** MailKite's edge spam verdict ("ham" | "spam" | null). */
  spam: string | null;
  /** ms since epoch, set when we store the event. */
  receivedAt: number;
}

/** Storage adapter — implemented by SQLite (Node) and D1 (Cloudflare Workers). */
export interface MessageStore {
  /** Insert or replace by id (webhook deliveries can retry — this keeps it idempotent). */
  put(msg: StoredMessage): Promise<void>;
  /** Newest first. */
  list(limit?: number): Promise<StoredMessage[]>;
  get(id: string): Promise<StoredMessage | null>;
  /**
   * Cache a route's webhook signing secret (captured when a domain is connected). MailKite signs
   * each route's deliveries with its own per-route secret, so `/inbound` verifies against these
   * (plus the optional `MAILKITE_WEBHOOK_SECRET` env fallback). Idempotent by secret value.
   */
  putSecret(secret: string): Promise<void>;
  /** Every cached signing secret — the candidate set `/inbound` verifies an incoming signature against. */
  listSecrets(): Promise<string[]>;
}

/** The slice of the MailKite SDK client the app needs — injectable so tests can stub the network. */
export interface ApiClient {
  send(message: {
    from: string;
    to: string;
    subject?: string;
    text?: string;
    inReplyTo?: string;
  }): Promise<{ id: string; status: string }>;
  /** The signed-in user's domains (id + name) — scopes the shared store to mail they actually own. */
  listDomains(): Promise<Array<{ id: string; domain: string }>>;
  /** The user's inbound routes — used to detect what's already wired so connect never clobbers. */
  listRoutes(): Promise<Array<{ match_pattern: string; action: string; destination: string | null }>>;
  /**
   * Set a domain's **catch-all** (`*@domain`) webhook. Only used by connect when the domain has NO
   * routes at all — otherwise we add a specific-address route (below) so we never touch the user's
   * existing default webhook / forwards.
   */
  setWebhook(id: string, body: { url: string }): Promise<{ signingSecret?: string }>;
  /** Add a specific inbound route (e.g. `inbox@domain` → this app) without disturbing other routes. */
  createRoute(body: { match: string; action: string; destination: string }): Promise<{ signing_secret?: string | null }>;
}

/** @deprecated kept as the send-only sub-shape; use {@link ApiClient}. */
export type Mailer = Pick<ApiClient, "send">;

/** The signed-in user for one request. */
export interface SignedIn {
  accessToken: string;
}

/**
 * The authentication seam. Production wires MailKite OAuth (see `core/auth.ts`); tests inject a
 * fake so the app can be exercised offline. `resolve` returns the current user (refreshing the
 * token as needed) or null when signed out; the three handshake methods back the /auth/* routes.
 */
export interface Auth {
  resolve(c: Context): Promise<SignedIn | null>;
  login(c: Context): Promise<Response> | Response;
  callback(c: Context): Promise<Response> | Response;
  logout(c: Context): Promise<Response> | Response;
}
