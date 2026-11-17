import { type Env, signingSecretOk, webhookUrlOk } from "./env";
import { WebhookRejectedError, buildWebhookPayload, replyBaseUrl, wakeGrokBot } from "./grok";
import { claimResend, getConsultation, listResendDue, markResendDelivered, recordResendError } from "./store";

/** Must match the cron string in wrangler.jsonc triggers.crons. */
export const RESEND_CRON = "*/10 * * * *";
/** The daily purge (see store.ts purgeExpired). Must match wrangler.jsonc too. */
export const PURGE_CRON = "17 18 * * *";

/**
 * Resend consultations that have no reply yet (called by the 10-minute cron),
 * so that a Grok Bot that was down picks them up once it is running again.
 * A failed resend never fails the consultation; it keeps waiting and the next run tries again.
 */
export async function resendPending(env: Env, now = new Date()): Promise<{ resent: number; failed: number }> {
  if (!env.GROK_WEBHOOK_URL || !env.GROK_WEBHOOK_KEY) return { resent: 0, failed: 0 };
  if (!webhookUrlOk(env)) {
    console.log("resend skipped: GROK_WEBHOOK_URL is not https");
    return { resent: 0, failed: 0 };
  }
  if (!signingSecretOk(env)) {
    console.log("resend skipped: REPLY_SIGNING_SECRET is missing or too short");
    return { resent: 0, failed: 0 };
  }
  let resent = 0;
  let failed = 0;
  for (const due of await listResendDue(env.DB, now)) {
    const c = await getConsultation(env.DB, due.id, now);
    if (!c || c.status !== "sent") continue;
    // A cron run has no request. Without PUBLIC_URL or a stored base URL there is no reply link.
    if (!replyBaseUrl(env, c)) {
      console.log("resend skipped: no PUBLIC_URL and no stored base URL", { id: c.id });
      continue;
    }
    // Claim after reading: the conditional UPDATE still refuses if a reply arrived or another run claimed it.
    if (!(await claimResend(env.DB, due.id, due.attempts, now))) continue;
    const attempt = due.attempts + 1;
    try {
      await wakeGrokBot(env, await buildWebhookPayload(env, c, attempt));
      await markResendDelivered(env.DB, c.id);
      resent++;
    } catch (error) {
      failed++;
      const kind = error instanceof WebhookRejectedError ? "rejected" : "uncertain";
      await recordResendError(env.DB, c.id, `Resend ${attempt}: ${error instanceof Error ? error.message : "error"}`);
      console.log("resend failed", { id: c.id, attempt, kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { resent, failed };
}
