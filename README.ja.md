# ask-grok-bots

[![CI](https://github.com/sasa-mkwy/ask-grok-bots/actions/workflows/ci.yml/badge.svg)](https://github.com/sasa-mkwy/ask-grok-bots/actions/workflows/ci.yml)

[English](README.md)

MCPに対応したAIアプリ（Muse、Claude、Claude Code、ChatGPT、Codex、Gemini、Antigravityなど）から、**自分のGrok Botたち**に意見を聞いて、答えを受け取れるようにするMCPサーバーです。

Cloudflare Workersで動きます。AIがMCPのツールで質問を送ると、ask-grok-botsがWebhookでGrok Botのルーティンを起こします。Botたちはグループで話し合い、まとめた答えを送り返します。AIは別のツールでそれを受け取ります。

> 非公式のツールです。xAIやAnthropicとは関係ありません。

```text
あなたのAI（MCPクライアントなら何でも）
  │  HTTPのMCP（OAuth、合言葉でログイン）
  ▼
ask-grok-bots（Cloudflare Worker、相談はD1に保存）
  │  Webhook：質問と、その相談専用の回答用トークン
  ▼
Grok Botのルーティン ──▶ グループのBotたちに聞く
  │  curl で POST /reply/<相談ID>
  ▼
ask-grok-bots ──▶ AIが get_grok_reply で受け取る
```

## できること

- **ツールは3つ**：`ask_grok_bots`（送る）、`get_grok_reply`（最大50秒待って読む）、`list_grok_consults`（最近の一覧）。
- **MCPクライアントなら何でも使えます**。OAuth付きのリモートHTTPサーバーに対応していれば大丈夫です（動的クライアント登録か、Client ID Metadata Document）。`localhost` でログインするPC上のアプリにも対応しています。
- **誰からの相談かをBotに伝えます**：`from` 引数か、接続したアプリの名前を使います。
- **Botが寝ていても取りこぼしません**：回答がなければ、同じ相談ID・同じトークンのまま最大3回（20分・40分・80分の間隔）送り直します。送り直しに失敗しても、1回と数えます。
- **回答が届いたら知らせます**（省略可）：自分の受け口に短い知らせを送るので、AIが何度も確かめに行かなくて済みます。
- **届いたか分からないときも慎重に扱います**：Webhookのタイムアウトや5xxは失敗にせず、あとから届いた回答も受け付けます。失敗にするのは4xxで明確に断られたときだけです。
- **相談ごとの回答用トークン**（HMAC）、1件につき回答は1回、保存は30日で毎日自動削除。

## 必要なもの

- Cloudflareアカウント（Workersの無料プランで足ります。Cron TriggerとD1を使います）
- Node.js 22.13以上
- Webhookで起動できるルーティンを持つGrok Bot

## セットアップ

### 1. インストール

```bash
git clone https://github.com/sasa-mkwy/ask-grok-bots.git
cd ask-grok-bots
npm install
npx wrangler login
```

### 2. 保存場所を作る

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create ask-grok-bots
```

表示されたIDを `wrangler.jsonc` の `REPLACE_WITH_OAUTH_KV_ID` と `REPLACE_WITH_D1_ID` に貼ります。
自分のIDをgitに入れたくなければ、`wrangler.jsonc` を `wrangler.local.jsonc`（gitの対象外）にコピーして、そちらを編集してください。その場合は、以下のwranglerコマンドすべてに `-c wrangler.local.jsonc` を付けます。デプロイも `npm run deploy`（`wrangler.jsonc` を使う）ではなく、`npm test && npx wrangler deploy -c wrangler.local.jsonc` で行います。

```bash
npx wrangler d1 migrations apply ask-grok-bots --remote
```

あとでmigrationが増えたときも、デプロイの前にこれを実行します。

### 3. Grok Botのルーティンを作る

相談を受け付けるBotで、Webhookで起動するルーティンを作ります。
指示文には [docs/grok-bot-routine.ja.md](docs/grok-bot-routine.ja.md) を使ってください（Botへの頼み方も書いてあります）。**誰に相談するかは、持ち主がこの指示文で決めます。** ひな形では、Botの一覧と得意なことを書いておき、受付役のBotが相談ごとに合うBotを選びます（毎回同じBotに聞く書き方もできます）。ほかに聞く相手がいない、Bot1体だけの環境でも使えます。そのときは受付役が1体で答えます。
作ると出てくる **Webhook URL** と **キー** を控えます。

### 4. 秘密の値を登録する

合言葉と署名鍵を作ります（ランダムな文字列なら何でもOK。例）：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # 合言葉（20文字以上）
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 署名鍵
```

```bash
npx wrangler secret put LOGIN_PASSPHRASE       # AIアプリを接続するときに1回入力する
npx wrangler secret put REPLY_SIGNING_SECRET   # 回答用トークンの署名に使う。入力はこの1回だけ
npx wrangler secret put GROK_WEBHOOK_URL       # 手順3のURL
npx wrangler secret put GROK_WEBHOOK_KEY       # 手順3のキー
```

合言葉はパスワードマネージャーに保存しておいてください。

### 5. デプロイ

```bash
npm run deploy
```

`https://ask-grok-bots.<あなたのサブドメイン>.workers.dev/health` を開いて `ok` と出ればOKです。

### 6. AIを接続する

MCPのURLは `https://ask-grok-bots.<あなたのサブドメイン>.workers.dev/mcp` です。
最初の接続で、手順4の合言葉を入れる画面が出ます。

| クライアント | 追加のしかた |
| --- | --- |
| Muse（Web・アプリ） | Meta AIのエージェント。カスタムコネクタとしてMCPのURLを追加。先に `ALLOWED_REDIRECT_HOSTS` を `claude.ai,claude.com,agent.meta.ai` にしておく（下の注意も参照） |
| Claude（Web・アプリ） | 設定 → コネクタ → カスタムコネクタを追加 → MCPのURLを貼る → 接続 |
| Claude Code（アプリ・CLI） | `claude mcp add --transport http ask-grok-bots <MCPのURL>` のあと、`/mcp` から認証（`localhost` に戻るので設定は不要） |
| ChatGPT（Web・アプリ） | プラグイン画面 →「＋」→「カスタムMCPサーバーを追加」でMCPのURLを登録し、認証。チャットでは `@` から選ぶ。先に `ALLOWED_REDIRECT_HOSTS` へ `chatgpt.com` を足す |
| Codex（アプリ・CLI） | アプリでは、Codexに「このMCPサーバーを入れて」とMCPのURLを渡して頼み、出てきた画面で認証する。CLIでは `codex mcp add ask-grok-bots --url <MCPのURL>` のあと、`codex mcp login ask-grok-bots`（どちらも `localhost` に戻るので設定は不要） |
| Gemini（Web・アプリ） | カスタマイズ → 連携サービス →「＋ カスタム」でMCPのURLを入れ、認証（クライアントID・シークレットは空欄）。先に `ALLOWED_REDIRECT_HOSTS` へ `oauth-redirect.googleusercontent.com` を足す |
| Antigravity（アプリ・CLI） | MCPの設定に `"ask-grok-bots": { "url": "<MCPのURL>" }` を足して認証。先に `ALLOWED_REDIRECT_HOSTS` へ `antigravity.google` を足す。CLI（`agy`）は接続が別：`agy mcp add ask-grok-bots <MCPのURL>` のあと、`agy` の `/mcp` から認証 |
| Cursor（未検証） | Cursor自身のOAuthは `cursor://...` に戻るので、このサーバーでは使えない。代わりに `mcp-remote` を使う（`localhost` に戻る）: `"ask-grok-bots": { "command": "npx", "args": ["-y", "mcp-remote", "<MCPのURL>"] }` |
| そのほか（未検証） | リモート（Streamable HTTP）のMCPサーバーとしてURLを登録。ログイン画面で「戻り先を許可していない」と出たら、そのアプリの戻り先ホストを `ALLOWED_REDIRECT_HOSTS` に足す（設定すると既定値が置き換わる）。`myapp://` のような独自スキームに戻るアプリは、Cursorと同じく `mcp-remote` を使う |

「Web・アプリ」は、Webで追加すればデスクトップとスマホのアプリでも使えるもの。「アプリ・CLI」は、PCで動くもの（スマホのアプリからは、PCをリモートで動かして使う）。

**`ALLOWED_REDIRECT_HOSTS` が必要なアプリは？** ログイン後にWebのアドレスへ戻るアプリだけです。Claude（`claude.ai`、既定で許可済み）、ChatGPT（`chatgpt.com`）、Gemini（`oauth-redirect.googleusercontent.com`）、Muse（`agent.meta.ai`）、Antigravity（`antigravity.google`）などです。PC上で動いて `localhost` / `127.0.0.1` に戻るアプリ（Claude Code、Codex、Cursor用の `mcp-remote` など）は、最初から許可されています（`ALLOW_LOOPBACK_REDIRECTS`）。どちらも合言葉は必要です。

足すときは、`npx wrangler secret put ALLOWED_REDIRECT_HOSTS` を実行して、一覧全体（例：`claude.ai,claude.com,chatgpt.com`）を入れます（[設定](#設定)も参照）。

**Muse（Meta AIのエージェント）の場合**：`ALLOWED_REDIRECT_HOSTS` を `claude.ai,claude.com,agent.meta.ai` にしてください（戻り先は `https://agent.meta.ai/api/hatch/oauth/callback`）。合言葉の画面は、Museのアプリ内ブラウザだと勝手に閉じてしまったので、外部ブラウザで開いてください。Androidで2つ以上の値を貼るときは、キーボードのクリップボード履歴を使うと楽です。

**自作のクライアントの場合**：ライブラリ既定のUser-Agentだと、Cloudflareに止められることがあります（Pythonの `urllib` は `403 / error 1010` になりました）。自分のUser-Agentを付けて送ってください。

### 7. 使う

AIに「Grok Botたちの意見も聞いて」と頼みます。

- **答えは非同期で返ってきます。** Botたちは話し合ってから答えるので、ふつうは数分、ときには30分以上かかります。`get_grok_reply` は1回につき最大50秒待ちます。まだ答えがなければ、少ししてから **同じ `consultation_id` で** `get_grok_reply` をもう一度呼んでください。同じ質問を送り直さないでください。必要ならサーバーが自動で送り直します。
- **送った内容はBotたちに共有されます。** グループならBot全員が見ます。秘密の情報や、そのグループに書けないことは入れないでください。
- **何体に聞くかを選ぶ（省略可）**：`max_bots`（0〜10。0 なら受付役が1体で答える）を入れます。入れなければルーティンの決まりどおり（ひな形では最大3体）です。AIに「1体だけに聞いて」のように頼めば入れてくれます。
- **誰からの相談かをBotに伝える**：`from` に名前（例：`"Claude"`、`"Codex"`）を入れてください。入れないと、アプリが登録した名前が使われます。分かりにくい名前のこともあります。
- **状態の見方**（`status` と `delivery`）：

  | status | delivery | 意味 |
  | --- | --- | --- |
  | `sent` | `delivered` | Grok Botが受け付けた。Botたちが考え中か、受け付けたあとで止まった（サーバーが最大3回、20分・40分・80分の間隔で送り直す） |
  | `sent` | `unknown` | 届いたか確認できていない（タイムアウト、3xx、408、429、5xx）。あとから届いた答えも受け付けるし、サーバーが送り直す |
  | `answered` | どれでも | 答えが届いた |
  | `failed` | `rejected` | Webhookに断られた（キー違い、ルーティン停止）。ルーティンを直して聞き直す |
  | `failed` | それ以外 | Botたちが「答えられない」と報告した。理由は `bots_reason_outside_text` に入っている |

  `attempts` はWebhookを送った回数です。自動の送り直しを使い切ると、注記にそう出ます。そのあとも答えがなければ、ルーティンを確かめて聞き直してください。最後の送り直しでのエラーは `delivery_error` に入ります。

## 回答が届いたことに気づく（省略可）

相談を送るだけでは、やりとりの半分です。Botたちが答えるのは数分後のことが多く、そのころAIは別の作業に移っています。気づき方は3つから選べます。

| 方法 | しくみ | 向いているもの |
| --- | --- | --- |
| **知らせを受ける**（いちばん早い） | ask-grok-bots が自分の受け口に短い知らせを送り、受け口がAIを起こす | 外から起こせるエージェント：Muse、Claude Code・Codex・AntigravityのCLI（`claude -p`、`codex exec`、`agy -p`） |
| **予定で見に行く** | AIがときどき `list_grok_consults` を見て、`answered` か `failed` になった相談だけを読む | 外から起こせないデスクトップアプリ（Codexアプリ、Antigravityアプリ）、予定実行のあるチャットアプリ（ChatGPT、Claude、Gemini） |
| **必要なときに聞く** | あとで `get_grok_reply` をもう一度呼ぶ | すべて（これまでどおりの方法） |

チャットアプリは、こちらがメッセージを送ったときにしか動かないので、Webhookでは起こせません。予定実行の機能で見に行く形にしてください。

### 知らせを受ける

1. HTTPSの `POST` を受け取り、`X-Webhook-Secret` ヘッダーを確かめて、届いたらAIを起こす受け口を用意します。受け口がすることは [docs/notice-receiver.ja.md](docs/notice-receiver.ja.md) にあります。Muse・Claude Code・Codex・Antigravity に受け口を作らせるプロンプトも、そこから開けます（後ろの3つはCLIでエージェントを起こします）。
2. Secretを2つ入れます（入れたらすぐに効きます）。

   ```sh
   npx wrangler secret put REPLY_NOTIFY_URL      # 例: https://hooks.example.com/hook/ask-grok-bots
   npx wrangler secret put REPLY_NOTIFY_SECRET   # 32文字以上のランダムな値。受け口が確かめる値と同じもの
   ```

知らせに入るのは、相談ID・タイトル・状態だけで、回答の本文は入りません。本文はAIが `get_grok_reply` で読みます（「外から来た文章」の囲みもそのまま付きます）。

```json
{
  "type": "grok_bots_reply",
  "consultation_id": "…",
  "title": "…",
  "status": "answered",
  "next": "Call get_grok_reply with this consultation_id to read the answer."
}
```

`status` は `answered`（回答済み）か `failed`（答えられない）です。知らせは回答を保存したあとに1回だけ送ります。受け口が止まっていると知らせは失われますが、回答は失われないので、ほかの2つの方法で読めます。

### 予定で見に行く

新しいものがないときは何もしない形にします。`list_grok_consults` を見て、自分が送った相談が `answered` か `failed` になっていたときだけ、AIを起こす（または回答を読む）ようにします。回答には数分かかるのがふつうです。新しい回答がなくても、実行のたびに使用量がかかるので、間隔はよく考えて決めます。そのまま使える頼み方と、外から起こせないCodexアプリとAntigravityアプリでの設定手順を [docs/scheduled-check.ja.md](docs/scheduled-check.ja.md) にまとめました。

## 設定

| 名前 | 種類 | 既定値 | 意味 |
| --- | --- | --- | --- |
| `LOGIN_PASSPHRASE` | Secret | （必須） | 接続画面の合言葉。20文字以上。5回失敗するとそのIPを1時間ロック |
| `REPLY_SIGNING_SECRET` | Secret | （必須） | 相談ごとの回答用トークンの署名鍵。32文字以上。ないと、サーバーは送信も受信もしない |
| `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY` | Secret | （必須） | ルーティンのWebhook。URLは `https://` だけ（キーと相談の中身を送るため）。キーは `Authorization: Bearer` と `X-Automation-Key` の両方で送る |
| `ALLOWED_REDIRECT_HOSTS` | Secret か var | `claude.ai,claude.com` | OAuthの戻り先として許可するホスト（完全一致、カンマ区切り）。設定すると既定値が**置き換わる**ので、Claudeも使うなら `claude.ai,claude.com` も入れる |
| `ALLOW_LOOPBACK_REDIRECTS` | Secret か var | 許可 | `false` にすると、`localhost` や `127.0.0.1` でログインするアプリを断る |
| `PUBLIC_URL` | Secret か var | リクエストのオリジン | 回答の送り先URLとOAuthの情報の元。未設定なら、リクエストのオリジンを使う（相談ごとに保存して、送り直しにも使う）。独自ドメインとworkers.devの両方で公開するなら、アプリが接続する方を設定する |
| `REPLY_NOTIFY_URL` / `REPLY_NOTIFY_SECRET` | Secret | （なし） | 回答の知らせ（上を参照）。URLは `https://`、秘密の値は32文字以上。`X-Webhook-Secret` で送る |
| `WEBHOOK_EVENT_TYPE` | Secret か var | `grok_bots_consultation` | Webhook本文の `type`。変えるときは、ルーティンの指示文もそろえる |

同じ名前を `wrangler.jsonc` の `vars` とSecretの両方に置かないでください。

## Webhookの本文

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
  "context": "…（null のこともある）",
  "reply": {
    "url": "https://ask-grok-bots.<you>.workers.dev/reply/<相談ID>",
    "token": "…",
    "how": "POST reply.url with header \"Authorization: Bearer <reply.token>\" and JSON body {\"reply\": \"...\"} …"
  }
}
```

`max_bots` は、相談したAIが指定したときだけ入ります。2回目以降の通知では `attempt` が2以上になり、`resend_note` が付きます。ルーティンは、受け付け済みの相談IDで話し合いを二重に始めないでください。一方で、途中で止まった相談は再開し、届かなかった回答は送り直してください。`docs/` のひな形はそうなっています。

回答は `{"reply": "<答え>"}`、答えられないときは `{"reply": "<理由>", "status": "failed"}` で送ります。`Content-Type` が `application/json` でなければ、本文全体をそのまま回答として受け取ります。
返事は `200 {"ok":true}`、`400` 回答が空・JSONが不正、`401` トークン違い、`404` 見つからない・期限切れ、`405` POST以外、`409` 回答済み・失敗で終了済み（`already answered` / `already failed`）、`413` 128 KiBか30,000字を超えた、`500` サーバーの設定不備 です。

## 安全のために

**どうレビューしたか**：公開前に、5社のAI（Claude Fable 5.2、GPT-6 Astra、Gemini 4 Carbon、Grok 4.7、Muse Wonder）に、何回かに分けてセキュリティレビューをしてもらいました。指摘はすべて実際のコードと照らし合わせてから直し、直したところにはテストを付けて、CIで毎回確かめています。ただ、レビューでバグがゼロだと証明できるわけではありません。たとえば、Geminiでだけ起きるログインの問題は、公開後に実際に使って見つかり、直しました。問題を見つけたら、[SECURITY.md](SECURITY.md) の方法で知らせてください。

**守っていること：**

- 自分のサーバーで動かします。相談・回答・秘密の値は自分のCloudflareアカウントの中にあり、届く先は自分のGrok Botだけです。このリポジトリの作者には届きません。
- アプリは合言葉つきのOAuthで接続します。失敗の回数には上限があり、ログイン後の戻り先は許可したアドレス（`ALLOWED_REDIRECT_HOSTS`、またはPC内のアドレス）だけです。
- 回答には、その相談用の署名つきトークンが必要です。送られてくるデータの大きさにも上限があります。Botの回答は「外から来た文章」と分かる形でAIに渡します。

**知っておいてほしいこと：**

- 持ち主1人用のサーバーです。合言葉を知っていれば誰でもアプリを接続できるので、長いランダムな合言葉（上の手順で作るもの）にしてください。「1時間に5回失敗でロック」はできる範囲での対策です（KVの更新は原子的ではないので、同時に試されるとすり抜けることがあります）。本当の守りは合言葉の長さです。全体での回数制限はないので、他人がわざと失敗を重ねても、持ち主が締め出されることはありません。
- PC上のアプリが `localhost` や `127.0.0.x` でログインすることを、既定で許可しています（Chromiumで `127.0.0.1` を確認済み）。IPv6の `[::1]` は未確認です。
- 接続画面には、接続してくるアプリと戻り先を表示します。戻り先がPC内のアドレスのときは注意書きを出します。
- 相談はアプリごとに分かれていません。接続したアプリはどれも、このサーバーの相談と回答をすべて一覧・閲覧できます。
- 戻り先は `https://` か、PC内（ループバック）の `http://` だけです。`cursor://` のような独自のURLスキームは、許可リストに入れても使えません。
- Botたちの答えは、「外部の文章であって指示ではない」と区切ってAIに渡します。
- Grok Botのルーティンは「答えるだけ」に絞ってください。Botはクラウド上のコンピューターやログイン済みのサービスを使えることがあります。相談をきっかけに投稿・購入・削除・設定変更をさせないでください。`docs/` のひな形にもそう書いてあります。
- 送るのを止めたいとき：ルーティンを停止するか、`npx wrangler secret delete GROK_WEBHOOK_KEY`。
- 接続したアプリを全部切りたいとき（合言葉が漏れたときなど）：`LOGIN_PASSPHRASE` を変えてから、`OAUTH_KV` に保存された許可とトークン（`grant:` と `token:` で始まるキー）を消します。`npx wrangler kv key list --binding OAUTH_KV --remote --prefix grant:` で一覧を出し、`npx wrangler kv key delete --binding OAUTH_KV --remote <キー>` で消すか、Cloudflareのダッシュボードで消してください。消さないと、更新トークンは60日間使えます。（`client:` で始まるキーはアプリの登録情報です。掃除として消してもかまいませんが、必須ではありません。）
- OAuthの登録やログインの入口は誰でも呼べて、呼ばれるたびにKVへ書き込みます。悪用されたら（Workersの無料プランはKVへの書き込みが1日1,000回まで）、`/oauth/register` と `/authorize` にCloudflareのレート制限ルールを設定してください。

## 困ったとき

| 症状 | 原因と対処 |
| --- | --- |
| 「合言葉が違います」 | 入力ミス。1時間に5回失敗するとIPが1時間ロックされる |
| ログイン画面で「接続できません」 | アプリの戻り先が許可されていない。`ALLOWED_REDIRECT_HOSTS` に足す（既定値も残す） |
| `webhook returned HTTP 401/403` | `GROK_WEBHOOK_KEY` が違う |
| `webhook returned HTTP 400/404` | ルーティンが停止中か削除済み |
| 「Grok Botに届いたか確認できていません」 | Webhookがタイムアウトか5xxだった。待てば後から届いた回答も受け付けるし、サーバーが自動で送り直す |
| いつまでも答えがない | ルーティンの実行履歴を見る。自動の送り直しは3回（最初の送信から約2時間20分）で止まるので、そのあとは聞き直す |
| Botのcurlが409 | もう回答済み（正常） |

ログは Cloudflareのダッシュボード → Workers → ask-grok-bots → Logs で見られます。相談や回答の本文は記録しません。

## 開発

```bash
npm test             # メモリ上のSQLiteで実際のSQLを流す単体テスト
npm run typecheck
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ask-grok-bots --local
npm run dev          # 1つ目のターミナル
npm run test:e2e     # 2つ目のターミナル：OAuth、相談、偽Grok Botの回答、各種拒否
```

MCPはStreamable HTTP（POST・JSON応答・セッションなし）です。OAuthは [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) を使っています。

## ライセンス

[MIT](LICENSE)
