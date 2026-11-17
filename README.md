# ask-grok-bots

[日本語](README.ja.md)

An MCP server that lets your AI apps (Claude, Claude Code, Codex, Muse, Antigravity, ...) ask **your Grok Bots** for their opinions and get the answer back.

It runs on Cloudflare Workers. Your AI sends a question with an MCP tool, ask-grok-bots wakes a Grok Bot routine through its webhook, the bots discuss in their group, and they POST their answer back. Your AI picks it up with another tool call.

> Unofficial. Not affiliated with xAI or Anthropic.

```text
Your AI (any MCP client)
  │  MCP over HTTP (OAuth, one passphrase)
  ▼
ask-grok-bots (Cloudflare Worker, consultations stored in D1)
  │  webhook: the question + a reply token for this consultation only
  ▼
Grok Bot routine ──▶ asks the bots in your group
  │  curl POST /reply/<consultation id>
  ▼
ask-grok-bots ──▶ your AI reads it with get_grok_reply
```

## Features

- **Three tools**: `ask_grok_bots` (send), `get_grok_reply` (wait up to 50 s and read), `list_grok_consults` (recent list).
- **Works with any MCP client** that supports remote HTTP servers with OAuth (dynamic client registration or Client ID Metadata Documents). Local apps that log in through `localhost` are supported.
- **Tells the bots who is asking**: the `from` argument, or the connected app's name.
- **Survives a sleeping bot**: if no reply arrives, the consultation is resent up to 3 times (20, 40 and 80 minutes apart), with the same id and token.
- **Careful with uncertain delivery**: a webhook timeout or 5xx is not treated as a failure; a late reply is still accepted. Only a clear 4xx refusal fails a consultation.
- **Per-consultation reply tokens** (HMAC), one reply per consultation, 30-day retention with a daily purge.

## Requirements

- A Cloudflare account (the Workers free plan is enough; cron triggers and D1 are used)
- Node.js 22.13 or later
- A Grok Bot with routines that can be triggered by a webhook

## Setup

### 1. Install

```bash
git clone https://github.com/sasa-mkwy/ask-grok-bots.git
cd ask-grok-bots
npm install
npx wrangler login
```

### 2. Create the storage

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create ask-grok-bots
```

Put the printed ids into `wrangler.jsonc` (`REPLACE_WITH_OAUTH_KV_ID`, `REPLACE_WITH_D1_ID`).
If you prefer to keep your ids out of git, copy `wrangler.jsonc` to `wrangler.local.jsonc` (ignored by git) and edit that instead. Then add `-c wrangler.local.jsonc` to every wrangler command below, and deploy with `npm test && npx wrangler deploy -c wrangler.local.jsonc` instead of `npm run deploy` (which uses `wrangler.jsonc`).

```bash
npx wrangler d1 migrations apply ask-grok-bots --remote
```

Run this again before deploying whenever a new migration is added.

### 3. Create the Grok Bot routine

Create a routine triggered by a webhook on the bot that will receive consultations.
Use [docs/grok-bot-routine.md](docs/grok-bot-routine.md) as the routine's instructions. **You decide who gets asked** in those instructions: by default you list your bots and what each is good at, and the receiving bot picks the best fit for each consultation (or you can always ask the same bots). A single bot with no one else to ask works too: it answers alone.
Note the **webhook URL** and **key** it gives you.

### 4. Set the secrets

Generate a passphrase and a signing key (any random strings; for example):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # passphrase (20+ chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # signing key
```

```bash
npx wrangler secret put LOGIN_PASSPHRASE       # typed once when an AI app connects
npx wrangler secret put REPLY_SIGNING_SECRET   # signs reply tokens; you never type it again
npx wrangler secret put GROK_WEBHOOK_URL       # from step 3
npx wrangler secret put GROK_WEBHOOK_KEY       # from step 3
```

Keep the passphrase in your password manager.

### 5. Deploy

```bash
npm run deploy
```

Open `https://ask-grok-bots.<your-subdomain>.workers.dev/health`; it should say `ok`.

### 6. Connect your AI

The MCP URL is `https://ask-grok-bots.<your-subdomain>.workers.dev/mcp`.
On first use, a page asks for the passphrase from step 4.

| Client | How to add |
| --- | --- |
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → Add custom connector → paste the MCP URL → Connect |
| Claude Code | `claude mcp add --transport http ask-grok-bots <MCP URL>`, then authenticate from `/mcp` (logs in through `localhost`: no setting needed) |
| Codex CLI | `codex mcp add ask-grok-bots --url <MCP URL>`, then `codex mcp login ask-grok-bots` (logs in through `localhost`: no setting needed) |
| Antigravity | Add `"ask-grok-bots": { "url": "<MCP URL>" }` to its MCP config and authenticate. Add `antigravity.google` to `ALLOWED_REDIRECT_HOSTS` first |
| Muse (Meta AI agents) | Add a custom connector with the MCP URL. Set `ALLOWED_REDIRECT_HOSTS` to `claude.ai,claude.com,agent.meta.ai` first (see the note below) |
| Cursor | Cursor's own OAuth returns to `cursor://...`, which this server does not accept. Use `mcp-remote` instead (it logs in through `localhost`): `"ask-grok-bots": { "command": "npx", "args": ["-y", "mcp-remote", "<MCP URL>"] }` (not tested yet) |
| Others | Add a remote (streamable HTTP) MCP server with the MCP URL. If the login page says the redirect target is not allowed, add the client's callback host to `ALLOWED_REDIRECT_HOSTS` (setting it replaces the default list). If the client uses a custom scheme such as `myapp://`, use `mcp-remote` as for Cursor |

**Which apps need `ALLOWED_REDIRECT_HOSTS`?** Only apps whose login returns to a web address: Claude (`claude.ai`, in the default list), Muse (`agent.meta.ai`), Antigravity (`antigravity.google`) and the like. Apps on your own computer that return to `localhost` / `127.0.0.1` (Claude Code, Codex CLI, `mcp-remote` for Cursor...) are allowed by default (`ALLOW_LOOPBACK_REDIRECTS`), and still need the passphrase.

**Muse (Meta AI agents)**: set `ALLOWED_REDIRECT_HOSTS` to `claude.ai,claude.com,agent.meta.ai` (the callback is `https://agent.meta.ai/api/hatch/oauth/callback`). The passphrase page closed by itself in Muse's in-app browser; open it in an external browser. On Android, use your keyboard's clipboard history if you need to paste more than one value.

**Your own client**: Cloudflare may block HTTP clients that send a default library User-Agent (Python's `urllib` got `403 / error 1010`). Send your own User-Agent.

### 7. Use it

Ask your AI: "Ask the Grok Bots what they think."

- **Replies are asynchronous.** Bots discuss before answering; it usually takes a few minutes and sometimes more than half an hour. `get_grok_reply` waits up to 50 seconds per call. If there is no reply yet, call `get_grok_reply` again later **with the same `consultation_id`**. Do not send the question again; the server resends it for you if needed.
- **Everything you send is shared with the bots**, and in a group every bot sees it. Do not include secrets or anything you would not post in that group.
- **Choose how many bots to ask (optional)**: set `max_bots` (0 to 10; 0 means the receiving bot answers alone). Without it, the routine decides (the template asks up to 3). Just tell your AI, e.g. "ask just one of them".
- **Tell the bots who is asking**: set `from` (e.g. `"Claude"`, `"Codex"`). Without it, the name your app registered with is used, which may be generic.
- **Reading the status** (`status` / `delivery`):

  | status | delivery | Meaning |
  | --- | --- | --- |
  | `sent` | `delivered` | The Grok Bot accepted it. The bots are working, or their side stopped after accepting (the server resends up to 3 times: 20, 40 and 80 minutes apart) |
  | `sent` | `unknown` | Not confirmed that it arrived (timeout, 3xx, 408, 429 or 5xx). A late reply is still accepted, and the server resends |
  | `answered` | any | The reply is in |
  | `failed` | `rejected` | The webhook refused it (bad key, paused routine). Fix the routine and ask again |
  | `failed` | other | The bots reported they could not answer; their reason is in `bots_reason_outside_text` |

  `attempts` counts the webhook sends. After the last automatic resend the note says so; if nothing arrives after that, check the routine and ask again. The last resend error, if any, is in `delivery_error`.

## Configuration

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `LOGIN_PASSPHRASE` | secret | (required) | Passphrase on the connect page, 20+ characters. 5 failures lock an IP for an hour |
| `REPLY_SIGNING_SECRET` | secret | (required) | Key for per-consultation reply tokens, 32+ characters. Without it the server refuses to send or accept anything |
| `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY` | secret | (required) | The routine's webhook. The key is sent as `Authorization: Bearer` and `X-Automation-Key` |
| `ALLOWED_REDIRECT_HOSTS` | secret or var | `claude.ai,claude.com` | Hosts allowed as OAuth redirect targets (exact match, comma-separated). Setting it **replaces** the default, so keep `claude.ai,claude.com` in the list if you use Claude |
| `ALLOW_LOOPBACK_REDIRECTS` | secret or var | allowed | Set `false` to refuse apps that log in through `localhost` / `127.0.0.1` |
| `PUBLIC_URL` | secret or var | the request's origin | Base URL used in reply links and OAuth metadata. Without it, the origin of each request is used (and stored with the consultation for resends). If you serve both a custom domain and workers.dev, set it to the one your apps connect to |
| `WEBHOOK_EVENT_TYPE` | secret or var | `grok_bots_consultation` | The `type` field of the webhook body. If you change it, change the routine instructions to match |

Do not define the same name both in `wrangler.jsonc` `vars` and as a secret.

## Webhook body

```json
{
  "type": "grok_bots_consultation",
  "from": "Claude",
  "max_bots": 2,
  "consultation_id": "…",
  "attempt": 1,
  "title": "…",
  "asked_at": "2026-11-17T00:00:00.000Z",
  "question": "…",
  "context": "… (or null)",
  "reply": {
    "url": "https://ask-grok-bots.<you>.workers.dev/reply/<consultation id>",
    "token": "…",
    "how": "POST reply.url with header \"Authorization: Bearer <reply.token>\" and JSON body {\"reply\": \"...\"} …"
  }
}
```

`max_bots` is present only when the asking AI set it. From the second attempt on, `attempt` is 2 or more and `resend_note` is added. The routine should not start a second discussion for a consultation id it already has, but should resume one that stalled or re-send an answer that was not delivered; the template in `docs/` does this.

Reply with `{"reply": "<answer>"}`, or `{"reply": "<reason>", "status": "failed"}` if the bots cannot answer.
Responses: `200 {"ok":true}`, `400` empty reply or invalid JSON, `401` bad token, `404` unknown or expired, `405` not a POST, `409` already answered, `413` over 128 KiB or 30,000 characters, `500` server misconfigured.

## Security notes

- This is a single-owner server: anyone with the passphrase can connect an app. Use a long random passphrase (the generated one above). The "5 failures per hour" lock is best effort (KV updates are not atomic, so parallel attempts can slip through); the passphrase's length is the real protection.
- Local apps are allowed to log in through `localhost` / `127.0.0.x` by default (tested in Chromium with `127.0.0.1`). IPv6 `[::1]` callbacks are not tested.
- The consent page shows which app is connecting and where it returns, and warns when it returns to a local address.
- Consultations are not separated per app: every connected app can list and read all consultations and replies on this server.
- Redirect targets must be `https://` or a loopback `http://` address. Custom URL schemes (such as `cursor://`) are not supported, even if listed.
- The bots' answer is handed to your AI fenced and labelled as outside text, not instructions.
- Keep the Grok Bot routine limited to answering. Bots may have access to a cloud computer and logged-in services; do not let a consultation make them post, buy, delete or change settings. The template in `docs/` says so.
- To stop sending: pause the routine, or `npx wrangler secret delete GROK_WEBHOOK_KEY`.
- To disconnect every app (for example after a passphrase leak): change `LOGIN_PASSPHRASE`, then delete the stored grants and tokens from the `OAUTH_KV` namespace (keys starting with `grant:` and `token:`; list them with `npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant:` and remove them with `npx wrangler kv key delete --binding OAUTH_KV --remote <key>`, or delete them in the Cloudflare dashboard). Refresh tokens otherwise stay valid for 60 days. (Keys starting with `client:` are app registrations; deleting them is optional cleanup.)
- Anyone can call the OAuth registration and login endpoints, and each call writes to KV. If you see abuse (the Workers Free plan allows 1,000 KV writes a day), add a Cloudflare rate limiting rule for `/oauth/register` and `/authorize`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Wrong passphrase" | Typo. 5 failures in an hour lock your IP for an hour |
| "Cannot connect" on the login page | The app's redirect host is not allowed. Add it to `ALLOWED_REDIRECT_HOSTS` (keep the defaults too) |
| `webhook returned HTTP 401/403` | `GROK_WEBHOOK_KEY` is wrong |
| `webhook returned HTTP 400/404` | The routine is paused or deleted |
| "Not confirmed that the Grok Bot received it" | The webhook timed out or answered 5xx. Wait; a late reply is accepted and the server resends automatically |
| No reply for a long time | Check the routine's run history. Resends stop after 3 (about 2 hours 20 minutes after the first send); ask again after that |
| The bot's curl gets 409 | Already answered (normal) |

Logs: Cloudflare dashboard → Workers → ask-grok-bots → Logs. Question and reply bodies are not logged.

## Development

```bash
npm test             # unit tests on an in-memory SQLite (real SQL)
npm run typecheck
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ask-grok-bots --local
npm run dev          # in one terminal
npm run test:e2e     # in another: OAuth, consult, fake Grok Bot reply, refusals
```

The MCP endpoint is Streamable HTTP (POST, JSON responses, no sessions). OAuth is handled by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).

## License

[MIT](LICENSE)
