// /authorize: the login + consent page shown once when an AI client connects.
// Login is a single passphrase (secret LOGIN_PASSPHRASE). This is a single-owner server, so there are no accounts.
import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { type Env, type GrantProps, codePointLength, parseList, secretEqual, truncate } from "./env";

const MAX_FAILURES_PER_HOUR = 5;
export const MIN_PASSPHRASE_CHARS = 20;
const USER_ID = "owner";

type Lang = "en" | "ja";
/** Japanese if the browser prefers it, English otherwise. */
const langOf = (request: Request): Lang =>
  /^ja\b/i.test((request.headers.get("Accept-Language") ?? "").trim()) ? "ja" : "en";
const t = (lang: Lang, en: string, ja: string) => (lang === "ja" ? ja : en);

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (lang: Lang, title: string, body: string, status = 200, headers = new Headers(), formActionExtra = "") => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  // form-action also applies to the redirect after the form POST (Chromium, WebKit), so the consent page
  // adds the redirect targets (see redirectFormAction); every other page allows posting to itself only.
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formActionExtra ? ` ${formActionExtra}` : ""}; frame-ancestors 'none'`,
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return new Response(
    `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1.25rem;line-height:1.7;color:#222}
h1{font-size:1.3rem}input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}
button{padding:.6rem 1.2rem;font-size:1rem;margin:.8rem .5rem 0 0}.note{color:#666;font-size:.9rem}.warn{color:#b00}
</style>${body}</html>`,
    { status, headers },
  );
};

function consentPage(lang: Lang, d: ConsentDescription, handle: string, headers: Headers): Response {
  const loopbackWarning = d.redirectIsLoopback
    ? `<p class="warn">${t(
        lang,
        "This app runs on your own computer (the connection returns to a local address). Only continue if you started this connection yourself.",
        "このアプリはあなたのPC上で動いています（接続後の戻り先がPC内のアドレスです）。自分で接続を始めた場合だけ続けてください。",
      )}</p>`
    : "";
  return page(
    lang,
    t(lang, "Connect to ask-grok-bots", "ask-grok-bots への接続"),
    `<h1>${t(lang, "Connect to ask-grok-bots", "ask-grok-bots への接続")}</h1>
<p>${t(
      lang,
      `<strong>${escape(displayName(d.clientName))}</strong> will be able to send consultations to your Grok Bots and read the replies, including consultations sent by other apps connected to this server.`,
      `<strong>${escape(displayName(d.clientName))}</strong> が、Grok Botへの相談を送ったり、回答を読んだりできるようになります。このサーバーにつないだほかのアプリの相談も読めます。`,
    )}</p>
<p class="note">${t(lang, "Returns to", "戻り先")}: <strong>${escape(d.redirectHost)}</strong>${
      d.clientDomain ? ` (${t(lang, "issued by", "発行元")}: ${escape(d.clientDomain)})` : ""
    }</p>
${loopbackWarning}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<label>${t(lang, "Passphrase", "合言葉")}<br><input type="password" name="passphrase" autocomplete="current-password" required autofocus></label>
<div><button name="decision" value="approve">${t(lang, "Connect", "接続する")}</button><button name="decision" value="deny" formnovalidate>${t(lang, "Cancel", "やめる")}</button></div>
</form>`,
    200,
    headers,
    redirectFormAction(d.redirectUri),
  );
}

/**
 * The CSP form-action sources for the redirect after the form POST, or "" if it has no web origin.
 * Browsers also check every further hop of that redirect, and some clients bounce through their own
 * redirector first (Gemini: oauth-redirect.googleusercontent.com, then gemini.google.com), so any
 * https target is allowed; an http (loopback) target adds its exact origin.
 */
function redirectFormAction(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "https:") return "https:";
    return url.protocol === "http:" ? `https: ${url.origin}` : "";
  } catch {
    return "";
  }
}

/** App names are self-asserted: drop control and bidi-formatting characters that could disguise them. */
export const displayName = (name: string) => truncate(name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim(), 80) || "(unnamed app)";

const isLoopbackHost = (host: string) =>
  host === "localhost" ||
  host === "[::1]" ||
  host === "::1" ||
  (/^127(\.\d{1,3}){3}$/.test(host) && host.split(".").every((octet) => Number(octet) <= 255));

/** Same policy as isRedirectAllowed, for a full URL such as an OAuth error redirect. */
export function isRedirectUrlAllowed(env: Env, redirectUrl: string): boolean {
  try {
    const host = new URL(redirectUrl).hostname.toLowerCase();
    return isRedirectAllowed(env, { redirectUri: redirectUrl, redirectIsLoopback: isLoopbackHost(host) });
  } catch {
    return false;
  }
}

/**
 * denyConsent() returns headers for a 302 (including Location). When we show our own HTML page instead,
 * keep the cookie clearing but drop Location: a Location header on a 4xx/5xx page confuses some clients.
 */
function pageDenial<T extends { headers: Headers }>(denied: T): T {
  denied.headers.delete("Location");
  return denied;
}

/** Is this redirect target allowed? Listed hosts always; loopback (local apps) unless ALLOW_LOOPBACK_REDIRECTS=false. */
export function isRedirectAllowed(env: Env, d: Pick<ConsentDescription, "redirectUri" | "redirectIsLoopback">): boolean {
  let url: URL;
  try {
    url = new URL(d.redirectUri);
  } catch {
    return false;
  }
  // The library already enforces this; checked again here so the allowlist never depends on it.
  if (d.redirectIsLoopback) {
    return url.protocol === "http:" || url.protocol === "https:"
      ? env.ALLOW_LOOPBACK_REDIRECTS?.trim().toLowerCase() !== "false"
      : false;
  }
  if (url.protocol !== "https:") return false;
  return parseList(env.ALLOWED_REDIRECT_HOSTS).includes(url.hostname.toLowerCase());
}

/**
 * The client's address for counting failures. IPv6 users usually control a whole /64,
 * so IPv6 addresses are grouped by their first four 16-bit groups.
 */
export function clientKey(request: Request): string {
  const ip = (request.headers.get("CF-Connecting-IP") ?? "unknown").toLowerCase();
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

const failureKey = (who: string) => `login-failures:${who}`;

async function failureCount(env: Env, who: string): Promise<number> {
  return Number((await env.OAUTH_KV.get(failureKey(who))) ?? "0");
}

async function bump(env: Env, who: string): Promise<void> {
  const count = (await failureCount(env, who)) + 1;
  await env.OAUTH_KV.put(failureKey(who), String(count), { expirationTtl: 3600 });
}

/**
 * Best effort: KV read-modify-write is not atomic, so concurrent failures can be undercounted.
 * The real protection is a long random passphrase (README: generated, 20+ characters); this only slows guessing.
 */
// There is deliberately no lock across all clients: a stranger could use it to lock the owner out,
// and a random 20+ character passphrase cannot be guessed by spreading attempts over many addresses.
async function recordFailure(env: Env, who: string): Promise<void> {
  await bump(env, who);
}

async function isLocked(env: Env, who: string): Promise<boolean> {
  return (await failureCount(env, who)) >= MAX_FAILURES_PER_HOUR;
}

async function clientNameOf(env: Env, clientId: string): Promise<string | undefined> {
  try {
    const name = (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName?.trim();
    return name ? displayName(name) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const lang = langOf(request);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      if (!isRedirectAllowed(env, details)) {
        return page(
          lang,
          t(lang, "Cannot connect", "接続できません"),
          `<h1>${t(lang, "Cannot connect", "接続できません")}</h1><p>${t(
            lang,
            "This server does not allow this app's redirect target. The owner can add it to ALLOWED_REDIRECT_HOSTS.",
            "このサーバーは、このアプリの戻り先を許可していません。管理者が ALLOWED_REDIRECT_HOSTS に追加すると接続できます。",
          )} (${escape(details.redirectHost)})</p>`,
          403,
        );
      }
      const consent = await oauth.beginConsent(authRequest);
      return consentPage(lang, details, consent.handle, consent.headers);
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      const who = clientKey(request);
      const back = t(lang, "Go back to the app", "アプリに戻る");

      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (!env.LOGIN_PASSPHRASE || codePointLength(env.LOGIN_PASSPHRASE) < MIN_PASSPHRASE_CHARS) {
        // A setup problem, not a guess: say so, and do not count it as a failure.
        const denied = pageDenial(await oauth.denyConsent(request, handle, { description: "server not configured" }));
        return page(
          lang,
          t(lang, "Server not set up", "サーバーの設定が終わっていません"),
          `<h1 class="warn">${t(lang, "Server not set up", "サーバーの設定が終わっていません")}</h1><p>${t(
            lang,
            `The owner has not set LOGIN_PASSPHRASE (${MIN_PASSPHRASE_CHARS}+ characters) yet.`,
            `管理者が LOGIN_PASSPHRASE（${MIN_PASSPHRASE_CHARS}文字以上）をまだ設定していません。`,
          )}</p><p><a href="${escape(denied.redirectTo)}">${back}</a></p>`,
          503,
          denied.headers,
        );
      }
      if (await isLocked(env, who)) {
        const denied = pageDenial(await oauth.denyConsent(request, handle, { description: "too many attempts" }));
        return page(
          lang,
          t(lang, "Please wait", "しばらく待ってください"),
          `<h1>${t(lang, "Locked for one hour after repeated failures", "失敗が続いたので1時間ロックしました")}</h1><p>${t(
            lang,
            "Try connecting again from the app later.",
            "時間をおいてから、アプリで接続し直してください。",
          )}</p><p><a href="${escape(denied.redirectTo)}">${back}</a></p>`,
          429,
          denied.headers,
        );
      }
      const passphrase = String(form.get("passphrase") ?? "");
      if (!(await secretEqual(passphrase, env.LOGIN_PASSPHRASE))) {
        // Validate (and consume) the cookie-bound consent transaction BEFORE counting the failure,
        // so a forged cross-site or cookieless POST cannot lock someone's IP out.
        const denied = pageDenial(await oauth.denyConsent(request, handle, { description: "wrong passphrase" }));
        await recordFailure(env, who);
        return page(
          lang,
          t(lang, "Wrong passphrase", "合言葉が違います"),
          `<h1 class="warn">${t(lang, "Wrong passphrase", "合言葉が違います")}</h1><p>${t(
            lang,
            "Go back to the app and connect again.",
            "アプリに戻って、もう一度「接続」からやり直してください。",
          )}</p><p><a href="${escape(denied.redirectTo)}">${back}</a></p>`,
          401,
          denied.headers,
        );
      }

      const approved = await oauth.approveConsent(request, handle);
      await env.OAUTH_KV.delete(failureKey(who)); // a successful login clears this client's failures
      const clientName = await clientNameOf(env, approved.request.clientId);
      const props: GrantProps = { userId: USER_ID, ...(clientName ? { clientName } : {}) };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: USER_ID,
        metadata: { label: clientName ?? "AI client" },
        scope: approved.request.scope,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    // Error redirects go back to the client only if its redirect target passes the same allowlist.
    if (error instanceof AuthorizationError && error.redirectTo && isRedirectUrlAllowed(env, error.redirectTo)) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError ? error.description : t(lang, "Could not verify this app.", "このアプリを確認できませんでした。");
      return page(
        lang,
        t(lang, "Connection error", "接続エラー"),
        `<h1>${t(lang, "Connection error", "接続エラー")}</h1><p>${escape(message ?? "")}</p><p>${t(
          lang,
          "Connect again from the app.",
          "アプリから接続し直してください。",
        )}</p>`,
        400,
      );
    }
    throw error;
  }
}
