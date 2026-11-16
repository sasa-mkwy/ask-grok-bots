import type { Env } from "./env";
import { normalizePublicUrl } from "./config";
import { type Consultation, signReplyToken } from "./store";

const WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_EVENT_TYPE = "grok_bots_consultation";
export const DEFAULT_SENDER = "an AI assistant";

/** The webhook clearly refused (4xx). The Grok Bot never got the consultation, so it is a terminal failure. */
export class WebhookRejectedError extends Error {}

/**
 * Unknown whether it arrived (timeout, connection drop, 5xx). The body may have reached the Grok Bot,
 * so do not fail the consultation; keep accepting a late reply.
 */
export class WebhookUncertainError extends Error {}

/**
 * Base URL for reply links: PUBLIC_URL if configured, else the URL stored when the consultation was created.
 * Cron resends do not pass through withDefaults() and have no request, so normalize here and fall back to the row.
 */
export function replyBaseUrl(env: Env, c: Pick<Consultation, "reply_base_url">): string | null {
  return normalizePublicUrl(env.PUBLIC_URL) ?? normalizePublicUrl(c.reply_base_url ?? undefined);
}

/** Body sent to the Grok Bot routine. The routine reads this JSON and POSTs its answer to reply.url. */
export async function buildWebhookPayload(env: Env, c: Consultation, attempt = 1) {
  return {
    type: env.WEBHOOK_EVENT_TYPE?.trim() || DEFAULT_EVENT_TYPE,
    from: c.asked_by || DEFAULT_SENDER,
    // Only when the asking AI set it; otherwise the routine's own rule applies.
    ...(c.max_bots === null || c.max_bots === undefined ? {} : { max_bots: c.max_bots }),
    consultation_id: c.id,
    // 2 or more means an automatic resend of the same consultation (see docs/grok-bot-routine.md for how to handle it).
    attempt,
    ...(attempt > 1
      ? {
          resend_note:
            "Automatic resend of the same consultation. Do not start a second discussion; follow your routine's rules for resends " +
            "(resume it if it stalled, re-send an answer that was not delivered).",
        }
      : {}),
    title: c.title,
    asked_at: c.created_at,
    question: c.question,
    context: c.context,
    reply: {
      url: `${replyBaseUrl(env, c)}/reply/${c.id}`,
      token: await signReplyToken(env.REPLY_SIGNING_SECRET, c.id),
      how:
        'POST reply.url with header "Authorization: Bearer <reply.token>" and JSON body {"reply": "<your answer>"}. ' +
        'If you cannot answer, send {"reply": "<reason>", "status": "failed"}. One reply per consultation.',
    },
  };
}

/** Wake the Grok Bot webhook routine. Returns on 2xx; otherwise throws one of the two errors above. */
export async function wakeGrokBot(env: Env, payload: unknown): Promise<void> {
  let response: Response;
  try {
    response = await globalThis.fetch(env.GROK_WEBHOOK_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        // The routine's "key". Sent in both headers so either check passes.
        Authorization: `Bearer ${env.GROK_WEBHOOK_KEY}`,
        "X-Automation-Key": env.GROK_WEBHOOK_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new WebhookUncertainError(
      // Only the error's kind: runtime messages can quote the webhook URL, which is a secret.
      `Could not confirm a response from the Grok Bot webhook (${error instanceof Error ? error.name : "error"})`,
    );
  }
  if (response.ok) return;
  // 408 (timeout) and 429 (rate limited) are temporary: keep waiting and let the cron resend.
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    const hint =
      response.status === 401 || response.status === 403
        ? "the webhook key may be wrong"
        : response.status === 400 || response.status === 404
          ? "the routine may be paused or deleted"
          : "the Grok Bot refused it";
    throw new WebhookRejectedError(`The Grok Bot webhook returned HTTP ${response.status} (${hint})`);
  }
  // 5xx, 3xx, 408 and 429: not delivered for sure, but not a permanent refusal either.
  throw new WebhookUncertainError(`The Grok Bot webhook returned HTTP ${response.status} (delivery unknown)`);
}
