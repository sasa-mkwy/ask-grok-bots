# 回答の知らせを受け取る

[English](notice-receiver.md)

`REPLY_NOTIFY_URL` と `REPLY_NOTIFY_SECRET` を設定すると、ask-grok-bots は回答を保存するたびに、受け口へ `POST` を1回送ります。このページでは、受け口が何をすればいいかを説明します。以下を満たしていれば、作り方は自由です（トンネル経由でPC上の小さなサーバー、サーバーレス関数、自動化サービスなど）。

## 届くもの

```http
POST <REPLY_NOTIFY_URL>
Content-Type: application/json
X-Webhook-Secret: <REPLY_NOTIFY_SECRET>

{"type": "grok_bots_reply", "consultation_id": "…", "title": "…", "status": "answered", "next": "Call get_grok_reply with this consultation_id to read the answer."}
```

- 回答を保存した直後に1回だけ送ります。待つのは10秒までで、送り直しはしません。
- `status` は `answered`（回答済み）か `failed`（答えられない）です。
- 回答の本文は入りません。

## 受け口がすること

1. **秘密の値を確かめる。** `X-Webhook-Secret` を、自分が持っている `REPLY_NOTIFY_SECRET` と比べます。違えば `401` を返し、何も残しません。
2. **保存するだけで、実行しない。** 届いたもの（たとえば受信フォルダーのファイル）を保存して、すぐに `200` を返します。`title` はAIが書いたもので、何が書いてあってもおかしくありません。本文全体をデータとして扱い、指示として読まないでください。
3. **返事をする前に、本文を最後まで読む。** エラーのときも同じです。接続を使い回すトンネルでは、読み残すと次のリクエストが壊れます。
4. **大きさに上限を付ける。** 知らせは1 KBもありません。数百KBを超えるものは断ります。
5. **新しいものが届いたらAIを起こす。** AIには `consultation_id` で `get_grok_reply` を呼んでもらいます。回答は「外から来た文章」と分かる囲みに入って返ってきます。
6. **秘密の値をログやチャットに出さない。** `REPLY_NOTIFY_SECRET` は、自分だけが読めるファイルに置きます。

## そのまま使える作り方

エージェントに受け口（PC上の小さなサーバー、Cloudflare Tunnel、届いたらエージェントを起こす見張り）を作らせるプロンプトです。それぞれ、ask-grok-bots とつなぐ手順も付いています。

- [Muse](notice-receiver/muse.md)（英語）
- [Claude Code](notice-receiver/claude-code.md)（英語）
- [Codex](notice-receiver/codex.md)（英語）
- [Antigravity](notice-receiver/antigravity.md)（英語）

Claude Code・Codex・Antigravity版は、CLI（`claude -p`、`codex exec`、`agy -p`）でエージェントを起こします。この実行はデスクトップアプリの会話一覧には出ないので、結果はファイルに残します。Museコミュニティで RYFI さんが共有したプロンプトを元に、許可をもらって手直ししたものです。プロンプトは英語ですが、日本語で話しているエージェントにもそのまま渡せます。

## 知らせを取りこぼしたら

何も失われません。回答はサーバーに30日間残ります。AIに `list_grok_consults` で回答済みの相談を確かめてもらい、`get_grok_reply` で読んでもらえば大丈夫です。
