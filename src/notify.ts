// Optional "a reply arrived" notice, so the asking AI does not have to keep polling.
// Sent to REPLY_NOTIFY_URL (for example a personal webhook receiver, see docs/notice-receiver.md).
// Only the id, title and status go out: the AI fetches the answer itself with get_grok_reply.
import { type Env, codePointLength } from "./env";

const NOTIFY_TIMEOUT_MS = 10_000;
export const NOTIFY_EVENT_TYPE = "grok_bots_reply";
const MIN_NOTIFY_SECRET_CHARS = 32;

/** Notices are on only with an https URL and a 32+ character secret. */
export function notifyConfigured(env: Pick<Env, "REPLY_NOTIFY_URL" | "REPLY_NOTIFY_SECRET">): boolean {
  if (!env.REPLY_NOTIFY_URL || codePointLength(env.REPLY_NOTIFY_SECRET ?? "") < MIN_NOTIFY_SECRET_CHARS) return false;
  try {
    return new URL(env.REPLY_NOTIFY_URL).protocol === "https:";
  } catch {
    return false;
  }
}

export interface ReplyNotice {
  consultation_id: string;
  title: string;
  status: "answered" | "failed";
}

/** Best effort: a failed notice never affects the reply, which is already saved. Never throws. */
export async function sendReplyNotice(env: Env, notice: ReplyNotice): Promise<void> {
  if (!notifyConfigured(env)) return;
  try {
    const response = await globalThis.fetch(env.REPLY_NOTIFY_URL!, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": env.REPLY_NOTIFY_SECRET! },
      body: JSON.stringify({
        type: NOTIFY_EVENT_TYPE,
        ...notice,
        next: "Call get_grok_reply with this consultation_id to read the answer.",
      }),
    });
    if (!response.ok) console.log("reply notice not accepted", { id: notice.consultation_id, status: response.status });
  } catch (error) {
    // Only the error's kind: runtime messages can quote the URL, which is a secret.
    console.log("reply notice failed", { id: notice.consultation_id, error: error instanceof Error ? error.name : "error" });
  }
}
