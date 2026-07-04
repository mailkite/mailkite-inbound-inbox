// Docs: docs/templates/inbound-inbox.md
// Shared contract between the webhook receiver, the storage adapters, and the UI.

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
}

/** The slice of the MailKite SDK client the app needs — injectable so tests can stub sends. */
export interface Mailer {
  send(message: {
    from: string;
    to: string;
    subject?: string;
    text?: string;
    inReplyTo?: string;
  }): Promise<{ id: string; status: string }>;
}
