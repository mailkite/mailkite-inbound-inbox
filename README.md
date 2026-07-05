# Inbound Inbox — your app's email inbox in one deploy

Give your app a real email inbox in about two minutes. [MailKite](https://mailkite.dev) turns
inbound email into a signed webhook; this template receives it, verifies the signature with the
official [`mailkite`](https://www.npmjs.com/package/mailkite) SDK, stores the message, renders a
minimal server-side inbox UI, and lets you reply — threaded — with one form.

**It's private.** The inbox lives on a public URL, so it's gated behind **sign-in with your
MailKite account** (OAuth 2.1 + PKCE) — never a shared API key that would expose your mail to
anyone with the link. Each visitor only sees mail for the domains *they* own, and replies send as
them. That means **one secret** (a webhook signing secret); the OAuth client registers itself.

One small TypeScript [Hono](https://hono.dev) app, two runtimes:

- **Cloudflare Workers + D1** (`cloudflare/`) — serverless, durable storage, one-click button.
- **Node + SQLite** (`src/node/`) — runs anywhere a container runs: Railway, Render,
  DigitalOcean, Fly, Docker.

## Deploy it

| Platform | |
|---|---|
| **Cloudflare Workers** (D1 storage) | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mailkite/mailkite-inbound-inbox) |
| **Railway** | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/uaQWFr?referralCode=qAKUtj&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mailkite/mailkite-inbound-inbox) |
| **DigitalOcean** | [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/mailkite/mailkite-inbound-inbox/tree/main) |
| **Fly.io** | `fly launch --from https://github.com/mailkite/mailkite-inbound-inbox` (creates the app + volume from `fly.toml`) |
| **Deno Deploy** | New-style Deno Deploy runs Node apps from GitHub: create an app at [console.deno.com](https://console.deno.com), point it at this repo with entrypoint `src/node/server.ts`. Storage is ephemeral there — prefer the Cloudflare or Fly targets for a persistent inbox. |

Every button prompts for a single secret: `MAILKITE_WEBHOOK_SECRET` (sign-in is OAuth — there's no
API key or OAuth client id/secret to enter).

## Before you deploy: verify a domain (2 minutes, required)

MailKite **gates inbound webhooks until your domain passes DNS verification** — without this
step no mail will ever reach the app.

1. Sign up at [app.mailkite.dev](https://app.mailkite.dev) and add a domain (or buy one there,
   pre-wired).
2. Add the DNS records it shows you — **MX** for receiving (plus SPF + DKIM for sending replies).
3. Wait for the domain to show **verified**, then grab your **webhook signing secret** (`whsec_…`)
   — dashboard → Webhooks → `MAILKITE_WEBHOOK_SECRET`. That's the only secret you set; there's no
   API key here (sign-in is OAuth).

## After you deploy: point the webhook here, then sign in

In the dashboard (or with the SDK/CLI), set your domain's webhook to your deployment:

```
https://<your-deployment>/inbound
```

Open your deployment — it redirects you to **sign in with MailKite** (Google / GitHub / email),
you approve access, and land in *your* inbox (mail for the domains you own). Send an email to
`anything@yourdomain.com`, refresh — it's there. Click it, type a reply, hit **Send reply**: it
goes out over your verified domain via `mk.send()`, threaded with `inReplyTo`. "Sign out" is in the
header.

## Environment

| Variable | Required | What |
|---|---|---|
| `MAILKITE_WEBHOOK_SECRET` | ✓ | Webhook signing secret (`whsec_…`) — verifies `x-mailkite-signature` on `POST /inbound`. **The only required var** (sign-in is OAuth; the app self-registers its OAuth client). |
| `MAILKITE_OAUTH_ISSUER` | | Override the OAuth issuer (defaults to `https://mcp.mailkite.dev`). Local testing against a dev API only. |
| `PORT` | | Node runtime only. Default `3000`. |
| `DATABASE_PATH` | | Node runtime only — SQLite file path. Default `./data/inbox.db` (`/data/inbox.db` in Docker; mount a volume there to keep mail across deploys). |

## Local development

Node runtime (SQLite):

```bash
npm install
cp .env.example .env        # fill in MAILKITE_WEBHOOK_SECRET
npm run dev                 # http://localhost:3000 → redirects you to sign in
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
npm test            # sign-in gating, domain scoping, webhook fixtures, reply, PKCE — no network
npm run typecheck
```

## How it works

```
sign in ─▶ OAuth 2.1 + PKCE ─▶ session cookie (your short-lived access token)
inbound email ─▶ MailKite ─▶ POST /inbound  (verify x-mailkite-signature via SDK, PUBLIC)
                                  │
                                  ▼
                    MessageStore (SQLite or D1)
                                  │
GET / (signed in) ◀── inbox scoped to YOUR domains ──▶ /messages/:id ──▶ POST /reply ─▶ mk.send()
```

- `src/core/` — runtime-agnostic app: routes, the auth gate, OAuth (`oauth.ts` / `auth.ts` /
  `session.ts`), webhook verification, UI, `MessageStore` interface.
- `src/node/` — Node entry + `better-sqlite3` adapter.
- `cloudflare/` — Workers entry + D1 adapter (table auto-created; no migrations to run).

The UI + reply routes are gated by `auth.resolve()` (a valid session, refreshed as needed); the
webhook is public (MailKite signs it). The store is shared, so each request is **scoped to the
domains the signed-in user owns** (`mk.listDomains()`) — mail for a domain you don't own reads as
"not found". All MailKite calls go through the official SDK, constructed with the user's **OAuth
access token** (`new MailKite(accessToken)`, sent as `Authorization: Bearer`, just like an API
key): `MailKite.verifyWebhook()` for signatures, `MailKite.replyOk()` for the ack, `mk.send()` for
replies, `mk.listDomains()` for scoping. Untrusted email HTML renders in a fully sandboxed
`<iframe>`, never in the page itself.

## License

[MIT](LICENSE)
