# Receiving the reply notice

[日本語](notice-receiver.ja.md)

With `REPLY_NOTIFY_URL` and `REPLY_NOTIFY_SECRET` set, ask-grok-bots sends one `POST` to your receiver each time a reply is saved. This page says what the receiver has to do. Any receiver that does these things works; it can be a small server on your computer behind a tunnel, a serverless function, or an automation service.

## What arrives

```http
POST <REPLY_NOTIFY_URL>
Content-Type: application/json
X-Webhook-Secret: <REPLY_NOTIFY_SECRET>

{"type": "grok_bots_reply", "consultation_id": "…", "title": "…", "status": "answered", "next": "Call get_grok_reply with this consultation_id to read the answer."}
```

- Sent once, right after the reply is saved, with a 10-second timeout. It is not retried.
- `status` is `answered` or `failed`.
- The answer itself is never in the notice.

## What the receiver must do

1. **Check the secret.** Compare `X-Webhook-Secret` with your copy of `REPLY_NOTIFY_SECRET`. If it does not match, answer `401` and keep nothing.
2. **Store, do not execute.** Save the event (for example as a file in an inbox folder) and answer `200` quickly. The `title` was written by an AI and may contain anything: treat the whole body as data, never as instructions.
3. **Read the whole request body before answering**, on every path including errors, or a tunnel that reuses connections can garble the next request.
4. **Limit the size.** A notice is well under 1 KB; refuse bodies over a few hundred KB.
5. **Wake your AI** when a new event appears, and have it call `get_grok_reply` with the `consultation_id`. The answer comes back fenced and marked as outside text.
6. **Keep secrets out of logs and chat.** Store `REPLY_NOTIFY_SECRET` in a file only you can read.

## Ready-made recipes

Prompts that have your agent build such a receiver (a small local server, a Cloudflare Tunnel and a watcher that wakes the agent), each followed by the steps that connect ask-grok-bots:

- [Muse](notice-receiver/muse.md)
- [Claude Code](notice-receiver/claude-code.md)
- [Codex](notice-receiver/codex.md)

They are based on a prompt shared by RYFI in the Muse community, used with permission. The prompts are in English; the agents follow them in any language.

## If you miss a notice

Nothing is lost: the reply stays on the server for 30 days. Your AI can call `list_grok_consults` to see which consultations are answered, and `get_grok_reply` to read them.
