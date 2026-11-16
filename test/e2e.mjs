// End-to-end check (local). Start `npx wrangler dev` in another terminal first.
// The fake Grok Bot in this script receives GROK_WEBHOOK_URL=http://127.0.0.1:9999/webhook from .dev.vars.
//   node test/e2e.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const PASSPHRASE = process.env.PASSPHRASE ?? "test-passphrase-0123456789";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const b64url = (buf) => buf.toString("base64url");

// ---- Fake Grok Bot: receives the webhook, thinks a little, then POSTs an answer ----
const received = [];
const fakeBot = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  received.push({ headers: req.headers, body: JSON.parse(body) });
  const payload = JSON.parse(body);
  // SLOW_ACK: take the body but hold the HTTP response past the Worker's 10 s webhook timeout
  if (payload.question.includes("SLOW_ACK")) setTimeout(() => res.writeHead(200).end("ok"), 15000);
  else if (payload.question.includes("REJECT")) res.writeHead(401).end("bad key");
  else res.writeHead(200).end("ok");
  if (payload.question.includes("REJECT")) return;
  if (payload.question.includes("NO_REPLY")) return;
  setTimeout(async () => {
    const r = await fetch(payload.reply.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.reply.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: `Bot A: I like it!\nBot B: Show the motive in chapter 2 a bit more. (question: ${payload.title})` }),
    });
    received.at(-1).replyStatus = r.status;
  }, 3000);
});
await new Promise((resolve) => fakeBot.listen(9999, resolve));

try {
  // ---- OAuth: discovery -> dynamic registration -> consent page -> passphrase -> token ----
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.ok(meta.registration_endpoint, "DCR endpoint advertised");

  const reg = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  ).json();
  assert.ok(reg.client_id, "registered");

  const authorizeUrl = (verifier, redirect = REDIRECT) => {
    const u = new URL(meta.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state: "st",
      resource: `${BASE}/mcp`,
    });
    return u;
  };

  async function openConsent(verifier) {
    const page = await fetch(authorizeUrl(verifier));
    assert.equal(page.status, 200, "consent page");
    const html = await page.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { handle, cookie };
  }
  const submit = (consent, fields) =>
    fetch(`${BASE}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: consent.cookie, Origin: BASE },
      body: new URLSearchParams({ handle: consent.handle, ...fields }),
    });

  // A wrong passphrase is refused
  const wrong = await submit(await openConsent(b64url(randomBytes(32))), { decision: "approve", passphrase: "nope" });
  assert.equal(wrong.status, 401, "wrong passphrase rejected");

  // A redirect host that is not allowed is refused even if registered
  const reg2 = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const evil = new URL(meta.authorization_endpoint);
  evil.search = new URLSearchParams({
    response_type: "code", client_id: reg2.client_id, redirect_uri: "https://evil.example/cb",
    code_challenge: b64url(createHash("sha256").update("x".repeat(50)).digest()), code_challenge_method: "S256", state: "s",
  });
  assert.equal((await fetch(evil)).status, 403, "unlisted redirect refused");

  // A local app (loopback redirect, e.g. Codex or Claude Code) gets the consent page by default
  const local = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Local CLI", redirect_uris: ["http://127.0.0.1:8765/callback"], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const localUrl = new URL(meta.authorization_endpoint);
  localUrl.search = new URLSearchParams({
    response_type: "code", client_id: local.client_id, redirect_uri: "http://127.0.0.1:8765/callback",
    code_challenge: b64url(createHash("sha256").update("y".repeat(50)).digest()), code_challenge_method: "S256", state: "s",
  });
  const localPage = await fetch(localUrl);
  assert.equal(localPage.status, 200, "loopback redirect allowed");

  const verifier = b64url(randomBytes(32));
  const ok = await submit(await openConsent(verifier), { decision: "approve", passphrase: PASSPHRASE });
  assert.equal(ok.status, 302, "approved");
  const location = new URL(ok.headers.get("location"));
  assert.equal(location.origin + location.pathname, REDIRECT);
  const code = location.searchParams.get("code");
  assert.ok(code, "got code");

  const token = await (
    await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id,
        code_verifier: verifier, resource: `${BASE}/mcp`,
      }),
    })
  ).json();
  assert.ok(token.access_token, `token: ${JSON.stringify(token)}`);

  // ---- MCP ----
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    assert.equal(r.status, 200, `${method} status`);
    return (await r.json()).result;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e" } });
  assert.equal(init.serverInfo.name, "ask-grok-bots");
  const tools = (await rpc("tools/list")).tools.map((t) => t.name);
  assert.deepEqual(tools, ["ask_grok_bots", "get_grok_reply", "list_grok_consults"]);

  const asked = await rpc("tools/call", {
    name: "ask_grok_bots",
    arguments: { title: "Chapter 2", question: "Is the hero's reason for leaving the village too weak?", context: "Fantasy novel. The hero is a blacksmith's daughter." },
  });
  assert.ok(!asked.isError, asked.content[0].text);
  const { consultation_id } = JSON.parse(asked.content[0].text);

  // The webhook arrived in the right shape
  const hook = received[0];
  assert.equal(hook.headers["x-automation-key"], "test-webhook-key");
  assert.equal(hook.headers.authorization, "Bearer test-webhook-key");
  assert.equal(hook.body.consultation_id, consultation_id);
  assert.equal(hook.body.context, "Fantasy novel. The hero is a blacksmith's daughter.");
  assert.equal(hook.body.from, "Claude", "sender defaults to the OAuth client name");
  assert.equal(hook.body.type, "grok_bots_consultation");

  // Wait for and receive the answer (the fake bot answers after 3 s)
  const got = await rpc("tools/call", { name: "get_grok_reply", arguments: { consultation_id, wait_seconds: 15 } });
  const replyText = got.content[0].text;
  assert.match(replyText, /"status": "answered"/);
  assert.match(replyText, /Bot B: Show the motive/);
  assert.match(replyText, /<<<GROK_BOTS_REPLY/);
  assert.equal(hook.replyStatus, 200);

  // A second reply and a wrong token are refused
  const again = await fetch(hook.body.reply.url, {
    method: "POST", headers: { Authorization: `Bearer ${hook.body.reply.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reply: "second" }),
  });
  assert.equal(again.status, 409, "double reply refused");
  const forged = await fetch(hook.body.reply.url, {
    method: "POST", headers: { Authorization: "Bearer forged", "Content-Type": "application/json" }, body: JSON.stringify({ reply: "x" }),
  });
  assert.equal(forged.status, 401, "forged token refused");

  // Without an answer, it returns sent after the wait time
  const pending = await rpc("tools/call", { name: "ask_grok_bots", arguments: { question: "NO_REPLY test" } });
  const pid = JSON.parse(pending.content[0].text).consultation_id;
  const t0 = Date.now();
  const still = await rpc("tools/call", { name: "get_grok_reply", arguments: { consultation_id: pid, wait_seconds: 3 } });
  assert.match(still.content[0].text, /"status": "sent"/);
  assert.ok(Date.now() - t0 >= 2900, "waited");

  // A late answer is received even if the webhook response timed out (answer arrives while waiting)
  const slow = await rpc("tools/call", { name: "ask_grok_bots", arguments: { question: "SLOW_ACK test" } });
  assert.ok(!slow.isError, slow.content[0].text);
  const slowResult = JSON.parse(slow.content[0].text);
  assert.equal(slowResult.delivery, "unknown");
  const slowGot = await rpc("tools/call", { name: "get_grok_reply", arguments: { consultation_id: slowResult.consultation_id, wait_seconds: 5 } });
  assert.match(slowGot.content[0].text, /"status": "answered"/, slowGot.content[0].text);

  // A clear refusal (401) is failed and still returns an id
  const rejected = await rpc("tools/call", { name: "ask_grok_bots", arguments: { question: "REJECT test" } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /"delivery": "rejected"/);
  assert.ok(JSON.parse(rejected.content[0].text).consultation_id);

  const list = await rpc("tools/call", { name: "list_grok_consults", arguments: { limit: 10 } });
  // Only check the consultations made by this run, so the script can run again on the same local D1.
  const listed = JSON.parse(list.content[0].text).consultations.map((c) => c.id);
  for (const mine of [consultation_id, pid, slowResult.consultation_id, JSON.parse(rejected.content[0].text).consultation_id]) {
    assert.ok(listed.includes(mine), `consultation ${mine} is listed`);
  }

  // No token: 401
  assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" })).status, 401);

  console.log("E2E OK");
} finally {
  fakeBot.close();
}
