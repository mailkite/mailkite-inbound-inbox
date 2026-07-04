// Docs: docs/templates/inbound-inbox.md
// Server-rendered inbox UI — Hono JSX, zero client-side framework.

import type { FC, PropsWithChildren } from 'hono/jsx';
import { snippet } from './inbound.js';
import type { StoredMessage } from './types.js';

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #f8fafc; color: #0f172a;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) { body { background: #0b1120; color: #e2e8f0; } }
a { color: inherit; text-decoration: none; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 64px; }
header.site { display: flex; align-items: baseline; gap: 10px; margin-bottom: 20px; }
header.site h1 { font-size: 18px; margin: 0; }
header.site .sub { font-size: 13px; opacity: .6; }
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
@media (prefers-color-scheme: dark) { .card { background: #101a2e; border-color: #1e293b; } }
.row { display: block; padding: 12px 16px; border-top: 1px solid #e2e8f0; }
.row:first-child { border-top: 0; }
.row:hover { background: rgba(37, 99, 235, .06); }
@media (prefers-color-scheme: dark) { .row { border-color: #1e293b; } }
.row .top { display: flex; justify-content: space-between; gap: 12px; }
.row .from { font-weight: 600; }
.row .when { font-size: 12px; opacity: .55; white-space: nowrap; }
.row .subject { margin-top: 2px; }
.row .snippet { font-size: 13px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #fee2e2; color: #b91c1c; margin-left: 6px; vertical-align: 1px; }
.empty { padding: 48px 24px; text-align: center; opacity: .65; }
.empty code { font-size: 13px; }
.msg-head { padding: 16px; border-bottom: 1px solid #e2e8f0; }
@media (prefers-color-scheme: dark) { .msg-head { border-color: #1e293b; } }
.msg-head h2 { margin: 0 0 6px; font-size: 17px; }
.msg-head .meta { font-size: 13px; opacity: .65; }
.msg-body { padding: 16px; }
.msg-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
.msg-body iframe { width: 100%; min-height: 320px; border: 0; background: #fff; border-radius: 6px; }
form.reply { padding: 16px; border-top: 1px solid #e2e8f0; display: grid; gap: 10px; }
@media (prefers-color-scheme: dark) { form.reply { border-color: #1e293b; } }
form.reply textarea {
  width: 100%; min-height: 110px; resize: vertical; padding: 10px 12px;
  border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: inherit; color: inherit;
}
form.reply button {
  justify-self: start; padding: 8px 18px; border: 0; border-radius: 8px;
  background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer;
}
form.reply button:hover { background: #1d4ed8; }
.note { margin: 0 0 16px; padding: 10px 14px; border-radius: 8px; font-size: 14px; }
.note.ok { background: #dcfce7; color: #166534; }
.note.err { background: #fee2e2; color: #b91c1c; }
.back { display: inline-block; margin-bottom: 12px; font-size: 13px; opacity: .65; }
.back:hover { opacity: 1; }
`;

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{CSS}</style>
    </head>
    <body>
      <main>
        <header class="site">
          <h1>
            <a href="/">Inbound Inbox</a>
          </h1>
          <span class="sub">
            powered by <a href="https://mailkite.dev">MailKite</a>
          </span>
        </header>
        {children}
      </main>
    </body>
  </html>
);

function when(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export const InboxPage: FC<{ messages: StoredMessage[] }> = ({ messages }) => (
  <Layout title="Inbound Inbox">
    <div class="card">
      {messages.length === 0 ? (
        <div class="empty">
          <p>No mail yet.</p>
          <p>
            Send an email to any address on your verified domain — it lands here via your
            MailKite webhook (<code>POST /inbound</code>).
          </p>
        </div>
      ) : (
        messages.map((m) => (
          <a class="row" href={`/messages/${encodeURIComponent(m.id)}`}>
            <div class="top">
              <span class="from">
                {m.fromAddr}
                {m.spam === 'spam' ? <span class="badge">spam</span> : null}
              </span>
              <span class="when">{when(m.receivedAt)}</span>
            </div>
            <div class="subject">{m.subject || '(no subject)'}</div>
            <div class="snippet">{snippet(m)}</div>
          </a>
        ))
      )}
    </div>
  </Layout>
);

export const MessagePage: FC<{ msg: StoredMessage; sent?: boolean; error?: string }> = ({
  msg,
  sent,
  error,
}) => (
  <Layout title={msg.subject || '(no subject)'}>
    <a class="back" href="/">
      &larr; Back to inbox
    </a>
    {sent ? <p class="note ok">Reply sent.</p> : null}
    {error ? <p class="note err">Reply failed: {error}</p> : null}
    <div class="card">
      <div class="msg-head">
        <h2>
          {msg.subject || '(no subject)'}
          {msg.spam === 'spam' ? <span class="badge">spam</span> : null}
        </h2>
        <div class="meta">
          From {msg.fromAddr} · To {msg.toAddr} · {when(msg.receivedAt)}
        </div>
      </div>
      <div class="msg-body">
        {msg.text ? (
          <pre>{msg.text}</pre>
        ) : msg.html ? (
          // Untrusted email HTML: render it inside a fully sandboxed iframe (no scripts,
          // no same-origin access) instead of injecting it into our page.
          <iframe sandbox="" srcdoc={msg.html} title="Email body" />
        ) : (
          <pre>(empty body)</pre>
        )}
      </div>
      <form class="reply" method="post" action="/reply">
        <input type="hidden" name="id" value={msg.id} />
        <textarea
          name="body"
          required
          placeholder={`Reply to ${msg.fromAddr} — sent from ${msg.toAddr}`}
        />
        <button type="submit">Send reply</button>
      </form>
    </div>
  </Layout>
);

export const NotFoundPage: FC = () => (
  <Layout title="Not found">
    <div class="card">
      <div class="empty">
        <p>Message not found.</p>
        <p>
          <a href="/">Back to inbox</a>
        </p>
      </div>
    </div>
  </Layout>
);
