# Security policy

[日本語は下にあります](#日本語)

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and which version (release tag or commit) you used.

You will get a reply when the report has been read. This is a personal project, so it may take a few days.

## Supported versions

Fixes go to the latest release and `main`. Each user runs their own copy, so update by pulling the new version and deploying it again (`npx wrangler deploy`).

## Scope

In scope: the code in this repository (the Worker, the OAuth login page, the MCP and reply endpoints) and the routine template in `docs/`.

Out of scope: Cloudflare, Grok, and the AI apps that connect to the server; problems that need the passphrase or another secret that the server owner has given away.

---

## 日本語

### 脆弱性の報告

セキュリティの問題は、公開のIssueには書かないでください。

このリポジトリの **Security** タブを開き、**Report a vulnerability** から非公開で知らせてください。見つけた内容、再現のしかた、使っていたバージョン（リリースのタグかコミット）を書いてもらえると助かります。

読んだら返事をします。個人のプロジェクトなので、数日かかることがあります。

### 対象のバージョン

修正は最新のリリースと `main` に入れます。それぞれが自分のサーバーで動かしているので、新しい版を取り込んで、もう一度デプロイ（`npx wrangler deploy`）してください。

### 対象の範囲

対象: このリポジトリのコード（Worker、OAuthのログイン画面、MCPと返信の受け口）と、`docs/` のルーティンのひな形。

対象外: Cloudflare、Grok、接続するAIアプリそのものの問題。サーバーの持ち主が合言葉などの秘密の値を他人に渡した場合の問題。
