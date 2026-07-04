// Docs: docs/templates/inbound-inbox.md
// Map a MailKite `email.received` webhook event to the row we store.

import type { InboundEvent, StoredMessage } from './types.js';

export function toStoredMessage(event: InboundEvent, now = Date.now()): StoredMessage {
  return {
    id: event.id,
    fromAddr: event.from?.address ?? 'unknown',
    toAddr: event.to?.[0]?.address ?? 'unknown',
    subject: event.subject ?? null,
    text: event.text ?? null,
    html: event.html ?? null,
    threadId: event.threadId ?? null,
    spam: event.auth?.spam ?? null,
    receivedAt: now,
  };
}

/** First ~140 chars of the body for the inbox list — text preferred, tags stripped from HTML. */
export function snippet(msg: Pick<StoredMessage, 'text' | 'html'>): string {
  const raw = msg.text ?? (msg.html ? msg.html.replace(/<[^>]*>/g, ' ') : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 140);
}
