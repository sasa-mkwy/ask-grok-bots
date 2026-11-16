import type { Env } from "./env";

export const DEFAULT_REDIRECT_HOSTS = "claude.ai,claude.com";

/**
 * A configured PUBLIC_URL reduced to its origin: lower-case host, no default port, no path such as "/mcp".
 * The OAuth library rejects anything else at startup, which would take down every route (/health and /reply too).
 * Returns null when it is not a usable http(s) URL.
 */
export function normalizePublicUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Fill in optional settings so the Worker runs without them.
 * Do not put PUBLIC_URL / ALLOWED_REDIRECT_HOSTS in both wrangler.jsonc "vars" and secrets:
 * a var and a secret with the same name make the deploy fail or overwrite each other.
 * - PUBLIC_URL: normalized to an origin; defaults to the origin of the incoming request (also when it is invalid)
 * - ALLOWED_REDIRECT_HOSTS: defaults to claude.ai and claude.com
 */
export function withDefaults(env: Env, request: Request): Env {
  const configured = normalizePublicUrl(env.PUBLIC_URL);
  if (env.PUBLIC_URL?.trim() && !configured) console.log("PUBLIC_URL is not a valid http(s) URL; using the request origin");
  const publicUrl = configured ?? new URL(request.url).origin;
  const redirectHosts = env.ALLOWED_REDIRECT_HOSTS?.trim() || DEFAULT_REDIRECT_HOSTS;
  if (publicUrl === env.PUBLIC_URL && redirectHosts === env.ALLOWED_REDIRECT_HOSTS) return env;
  return { ...env, PUBLIC_URL: publicUrl, ALLOWED_REDIRECT_HOSTS: redirectHosts };
}
