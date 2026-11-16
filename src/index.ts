import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./auth";
import { withDefaults } from "./config";
import type { Env, GrantProps } from "./env";
import { handleMcp } from "./mcp";
import { handleReply } from "./reply";
import { PURGE_CRON, RESEND_CRON, resendPending } from "./resend";
import { purgeExpired } from "./store";

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    const match = url.pathname.match(/^\/reply\/([0-9a-f-]{36})$/);
    if (match) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
      return handleReply(request, env, match[1]);
    }
    return new Response("not found", { status: 404 });
  },
};

const mcpHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => handleMcp(request, env, ctx.props as GrantProps | undefined),
};

/**
 * One provider per public URL. Without PUBLIC_URL, each origin the Worker is reached on (workers.dev, a custom
 * domain) gets its own metadata instead of the first origin being fixed for the whole isolate.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(env: Env): OAuthProvider<Env> {
  const existing = providers.get(env.PUBLIC_URL);
  if (existing) return existing;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["grok:consult"],
    resourceMetadata: {
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
    },
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 60 * 24 * 60 * 60,
  });
  // Without PUBLIC_URL every distinct origin gets an entry; keep the cache small.
  if (providers.size >= 16) providers.clear();
  providers.set(env.PUBLIC_URL, provider);
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const filled = withDefaults(env, request);
    return getProvider(filled).fetch(request, filled, ctx);
  },
  /**
   * Cron:
   * - every 10 minutes (RESEND_CRON): resend consultations without a reply
   * - daily: delete expired consultations (they are already unreadable and unanswerable before deletion)
   */
  async scheduled(controller: ScheduledController, env: Env) {
    if (controller.cron === RESEND_CRON) {
      const result = await resendPending(env);
      if (result.resent || result.failed) console.log("resent pending consultations", result);
      return;
    }
    if (controller.cron !== PURGE_CRON) {
      // Still purge (harmless), but make a schedule mismatch visible: resends would silently stop otherwise.
      console.log("unknown cron; expected", { got: controller.cron, resend: RESEND_CRON, purge: PURGE_CRON });
    }
    const deleted = await purgeExpired(env.DB);
    console.log("purged expired consultations", { deleted });
  },
} satisfies ExportedHandler<Env>;
