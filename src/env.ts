import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** KV for OAuth client registrations and (hashed) tokens. Used by the OAuth library. */
  OAUTH_KV: KVNamespace;
  /** D1 database for consultations and replies. */
  DB: D1Database;
  /** OAuth helpers injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;

  /** Public base URL without a trailing slash, e.g. https://ask-grok-bots.<you>.workers.dev. Optional (see config.ts). */
  PUBLIC_URL: string;
  /** Comma-separated hostnames allowed as OAuth redirect targets. Optional (see config.ts). */
  ALLOWED_REDIRECT_HOSTS: string;
  /** Set to "false" to refuse redirects to loopback addresses (localhost, 127.0.0.1, ::1). Default: allowed. */
  ALLOW_LOOPBACK_REDIRECTS?: string;
  /** The "type" field of the webhook payload. Default: "grok_bots_consultation". */
  WEBHOOK_EVENT_TYPE?: string;

  // ---- Secrets (npx wrangler secret put <NAME>) ----
  /** Passphrase typed once on the consent page when an AI client connects (20+ characters). */
  LOGIN_PASSPHRASE: string;
  /** Webhook URL of the Grok Bot routine. */
  GROK_WEBHOOK_URL: string;
  /** Webhook key (sender key) of the Grok Bot routine. */
  GROK_WEBHOOK_KEY: string;
  /** Key for signing per-consultation reply tokens (32+ random characters). */
  REPLY_SIGNING_SECRET: string;
}

/** Properties stored with each OAuth grant, available as ctx.props in the MCP handler. */
export interface GrantProps {
  userId: string;
  /** The OAuth client's registered name (self-asserted by the client). Absent on grants made before v0.2. */
  clientName?: string;
}

export const MIN_SIGNING_SECRET_CHARS = 32;

/** An empty or short signing key would make reply tokens guessable, so refuse to work without a proper one. */
export const signingSecretOk = (env: Pick<Env, "REPLY_SIGNING_SECRET">) =>
  codePointLength(env.REPLY_SIGNING_SECRET ?? "") >= MIN_SIGNING_SECRET_CHARS;

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Compare a secret with a candidate without leaking where they differ or how long the secret is:
 * both are hashed to fixed-length SHA-256 digests first, then compared byte by byte without early exit.
 */
export async function secretEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

/** Length in Unicode code points (what JSON Schema's maxLength counts), not UTF-16 units. */
export const codePointLength = (text: string) => Array.from(text).length;

/** Cut to at most max code points, never splitting a surrogate pair (emoji etc.). */
export const truncate = (text: string, max: number) => Array.from(text).slice(0, max).join("");

/** The webhook carries the key and the consultation, so it must be https. */
export function webhookUrlOk(env: Pick<Env, "GROK_WEBHOOK_URL">): boolean {
  try {
    return new URL(env.GROK_WEBHOOK_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
}
