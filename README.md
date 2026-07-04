# Inbound Inbox — your app's email inbox in one deploy

Give your app a real email inbox in about two minutes. [MailKite](https://mailkite.dev) turns
inbound email into a signed webhook; this template receives it, verifies the signature with the
official [`mailkite`](https://www.npmjs.com/package/mailkite) SDK, stores the message, renders a
minimal server-side inbox UI, and lets you reply — threaded — with one form.

One small TypeScript [Hono](https://hono.dev) app, two runtimes:

- **Cloudflare Workers + D1** (`cloudflare/`) — serverless, durable storage, one-click button.
- **Node + SQLite** (`src/node/`) — runs anywhere a container runs: Railway, Render,
  DigitalOcean, Fly, Docker.

## Deploy it

| Platform | |
|---|---|
| **Cloudflare Workers** (D1 storage) | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mailkite/mailkite-inbound-inbox) |
| **Railway** | [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fmailkite%2Fmailkite-inbound-inbox) |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mailkite/mailkite-inbound-inbox) |
| **DigitalOcean** | [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/mailkite/mailkite-inbound-inbox/tree/main) |
| **Fly.io** | `fly launch --from https://github.com/mailkite/mailkite-inbound-inbox` (creates the app + volume from `fly.toml`) |
| **Deno Deploy** | New-style Deno Deploy runs Node apps from GitHub: create an app at [console.deno.com](https://console.deno.com), point it at this repo with entrypoint `src/node/server.ts`. Storage is ephemeral there — prefer the Cloudflare or Fly targets for a persistent inbox. |

Every button prompts for the same two secrets: `MAILKITE_API_KEY` and `MAILKITE_WEBHOOK_SECRET`.

## Before you deploy: verify a domain (2 minutes, required)

MailKite **gates inbound webhooks until your domain passes DNS verification** — without this
step no mail will ever reach the app.

1. Sign up at [app.mailkite.dev](https://app.mailkite.dev) and add a domain (or buy one there,
   pre-wired).
2. Add the DNS records it shows you — **MX** for receiving (plus SPF + DKIM for sending replies).
3. Wait for the domain to show **verified**, then grab:
   - an **API key** (`mk_live_…`) — dashboard → API keys → `MAILKITE_API_KEY`
   - your **webhook signing secret** (`whsec_…`) — dashboard → Webhooks → `MAILKITE_WEBHOOK_SECRET`

## After you deploy: point the webhook here

In the dashboard (or with the SDK/CLI), set your domain's webhook to your deployment:

```
https://<your-deployment>/inbound
```

Send an email to `anything@yourdomain.com`, refresh `/` — it's in the inbox. Click it, type a
reply, hit **Send reply**: the reply goes out over your verified domain via `mk.send()`, threaded
with `inReplyTo`.

## Environment

| Variable | Required | What |
|---|---|---|
| `MAILKITE_API_KEY` | ✓ | MailKite API key (`mk_live_…`) — used to send replies. |
| `MAILKITE_WEBHOOK_SECRET` | ✓ | Webhook signing secret (`whsec_…`) — verifies `x-mailkite-signature` on `POST /inbound`. |
| `PORT` | | Node runtime only. Default `3000`. |
| `DATABASE_PATH` | | Node runtime only — SQLite file path. Default `./data/inbox.db` (`/data/inbox.db` in Docker; mount a volume there to keep mail across deploys). |

## Local development

Node runtime (SQLite):

```bash
npm install
cp .env.example .env        # fill in your key + webhook secret
npm run dev                 # http://localhost:3000
```

Cloudflare runtime (local D1, no account needed):

```bash
cp .dev.vars.example .dev.vars
npm run cf:dev
```

To receive real webhooks locally, expose the port (`ngrok http 3000` / `cloudflared tunnel`) and
set the public URL + `/inbound` as your domain's webhook.

Tests and typecheck:

```bash
npm test            # signed-webhook fixtures, storage, reply flow — no network
npm run typecheck
```

## How it works

```
inbound email ─▶ MailKite ─▶ POST /inbound  (verify x-mailkite-signature via SDK)
                                  │
                                  ▼
                    MessageStore (SQLite or D1)
                                  │
GET /  ◀── server-rendered inbox (Hono JSX) ──▶ GET /messages/:id ──▶ POST /reply ─▶ mk.send()
```

- `src/core/` — runtime-agnostic app: routes, webhook verification, UI, `MessageStore` interface.
- `src/node/` — Node entry + `better-sqlite3` adapter.
- `cloudflare/` — Workers entry + D1 adapter (table auto-created; no migrations to run).

All MailKite calls go through the official SDK: `MailKite.verifyWebhook()` for signature checks,
`MailKite.replyOk()` for the ack body, `mk.send()` for replies. Untrusted email HTML renders in a
fully sandboxed `<iframe>`, never in the page itself.

## License

[MIT](LICENSE)
