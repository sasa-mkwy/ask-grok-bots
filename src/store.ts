import { secretEqual } from "./env";

/**
 * Reply status.
 * - sent: waiting for a reply (a signed reply is accepted later)
 * - answered: a reply arrived
 * - failed: terminal failure (the webhook clearly refused, or the bot reported it cannot answer)
 */
export type Status = "sent" | "answered" | "failed";

/**
 * Webhook delivery, kept separately from the reply status.
 * - pending: being sent
 * - delivered: the webhook answered 2xx
 * - unknown: timeout, connection drop, 5xx... (keep waiting for a reply)
 * - rejected: the webhook clearly refused with 4xx (status becomes failed)
 */
export type Delivery = "pending" | "delivered" | "unknown" | "rejected";

export interface Consultation {
  id: string;
  title: string;
  question: string;
  context: string | null;
  /** Who asked (shown to the Grok Bot as "from"). */
  asked_by: string | null;
  /** At most how many other bots to ask, if the asking AI set it; null lets the routine decide. */
  max_bots: number | null;
  /** Public base URL at creation time; used for reply links when PUBLIC_URL is not configured. */
  reply_base_url: string | null;
  status: Status;
  delivery: Delivery;
  reply: string | null;
  error: string | null;
  created_at: string;
  answered_at: string | null;
  /** Webhook sends so far, first one included (column default 1; set by the resend cron). */
  attempts?: number;
}

/**
 * Retention. From the moment RETENTION_DAYS have passed since created_at (inclusive), a consultation is expired:
 * it can no longer be read, listed or answered, and the daily cron deletes it.
 */
export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

/** Only consultations newer than this (created_at > cutoff) are valid. */
export function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - RETENTION_MS).toISOString();
}

export async function insertConsultation(db: D1Database, c: Consultation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO consultations (id, title, question, context, asked_by, max_bots, reply_base_url, status, delivery, reply, error, created_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.title, c.question, c.context, c.asked_by, c.max_bots, c.reply_base_url, c.status, c.delivery, c.reply, c.error, c.created_at, c.answered_at)
    .run();
}

export async function getConsultation(db: D1Database, id: string, now = new Date()): Promise<Consultation | null> {
  return db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND created_at > ?`)
    .bind(id, retentionCutoff(now))
    .first<Consultation>();
}

export async function listConsultations(db: D1Database, limit: number, now = new Date()) {
  const { results } = await db
    .prepare(
      `SELECT id, title, asked_by, status, delivery, created_at, answered_at FROM consultations
       WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(retentionCutoff(now), limit)
    .all<Pick<Consultation, "id" | "title" | "asked_by" | "status" | "delivery" | "created_at" | "answered_at">>();
  return results;
}

/**
 * Record the delivery result. Never touches the reply (status, reply), so an early reply is not overwritten,
 * and never overwrites a delivery result already recorded.
 */
export async function markDelivery(db: D1Database, id: string, delivery: "delivered" | "unknown", note?: string) {
  await db
    .prepare(
      `UPDATE consultations SET delivery = ?, error = COALESCE(error, ?)
       WHERE id = ? AND delivery = 'pending'`,
    )
    .bind(delivery, delivery === "unknown" ? (note ?? null) : null, id)
    .run();
}

/**
 * Mark a terminal failure only when the webhook clearly refused.
 * Only rows still waiting (sent) change; answered rows and bot failure reports are kept.
 * Returns true when the failure was recorded.
 */
export async function markRejected(db: D1Database, id: string, error: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE consultations SET status = 'failed', delivery = 'rejected', error = ?
       WHERE id = ? AND status = 'sent'`,
    )
    .bind(error, id)
    .run();
  if (result.meta.changes !== 1) {
    // A reply (or a bot failure report) already arrived, which proves the webhook body was delivered,
    // whatever the late 4xx says. Do not label the bots' own report as a webhook refusal.
    await db.prepare(`UPDATE consultations SET delivery = 'delivered' WHERE id = ? AND delivery = 'pending'`).bind(id).run();
  }
  return result.meta.changes === 1;
}

export type SaveReplyResult = "saved" | "not_found" | "already_closed";

/**
 * Save a reply. Writes only while the consultation is valid and waiting (sent); the UPDATE itself enforces this.
 * A bot failure report is saved as status=failed. Delivery does not matter (a late reply after "unknown" is accepted).
 */
export async function saveReply(
  db: D1Database,
  id: string,
  reply: string,
  failed: boolean,
  now = new Date(),
): Promise<SaveReplyResult> {
  const result = await db
    .prepare(
      `UPDATE consultations SET status = ?, reply = ?, error = ?, answered_at = ?
       WHERE id = ? AND status = 'sent' AND created_at > ?`,
    )
    .bind(
      failed ? "failed" : "answered",
      failed ? null : reply,
      failed ? reply : null,
      now.toISOString(),
      id,
      retentionCutoff(now),
    )
    .run();
  if (result.meta.changes === 1) return "saved";
  return (await getConsultation(db, id, now)) ? "already_closed" : "not_found";
}

/**
 * Automatic resend. If the Grok Bot side was down and missed a consultation, resend it with the same id and
 * the same reply token, backing off: 20 minutes after the first send, then 40, then 80 minutes after the
 * previous one (3 resends, about 2 hours 20 minutes in all). A discussion usually takes up to ~10 minutes plus
 * the time the bot needs to wake up, so the first resend waits 20 minutes; each resend wakes the routine and
 * uses the bot's quota, so there are few of them. The cron runs every 10 minutes; the due check allows
 * 1 minute of cron jitter.
 */
export const RESEND_FIRST_MINUTES = 20;
export const MAX_RESENDS = 3;
/** Minutes to wait after the latest send before the next resend, given how many sends were made so far. */
export const resendDelayMinutes = (attempts: number) => RESEND_FIRST_MINUTES * 2 ** Math.max(0, attempts - 1);
/**
 * Consultations handled per cron run. Each costs up to 3 D1 queries (read, claim, mark), plus 1 for the list,
 * which keeps a run well under the Workers Free limit of 50 D1 queries per invocation. The rest wait for the next run.
 */
export const RESEND_BATCH = 10;

export interface ResendCandidate {
  id: string;
  attempts: number;
}

/**
 * Consultations to resend: waiting (sent), not expired, under the attempt limit, and last sent long enough ago.
 * Rejected ones are status=failed and therefore excluded.
 */
export async function listResendDue(db: D1Database, now = new Date()): Promise<ResendCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, attempts FROM consultations
       WHERE status = 'sent' AND created_at > ? AND attempts <= ?
         AND (julianday(?) - julianday(COALESCE(last_sent_at, created_at))) * 1440 >= (? << (attempts - 1)) - 1
       ORDER BY COALESCE(last_sent_at, created_at) ASC LIMIT ?`,
    )
    .bind(retentionCutoff(now), MAX_RESENDS, now.toISOString(), RESEND_FIRST_MINUTES, RESEND_BATCH)
    .all<ResendCandidate>();
  return results;
}

/** Claim the right to resend (increments attempts). False if a reply arrived or another run claimed it first. */
export async function claimResend(db: D1Database, id: string, attempts: number, now = new Date()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE consultations SET attempts = attempts + 1, last_sent_at = ?
       WHERE id = ? AND status = 'sent' AND attempts = ?`,
    )
    .bind(now.toISOString(), id, attempts)
    .run();
  return result.meta.changes === 1;
}

/**
 * After a resend is accepted with 2xx, mark it delivered and clear the first attempt's delivery error.
 * Only rows still waiting (sent) change, so a bot failure report (error on status=failed) is kept.
 */
/** Keep the last resend error visible to get_grok_reply. The consultation keeps waiting (status stays sent). */
export async function recordResendError(db: D1Database, id: string, error: string) {
  await db.prepare(`UPDATE consultations SET error = ? WHERE id = ? AND status = 'sent'`).bind(error, id).run();
}

export async function markResendDelivered(db: D1Database, id: string) {
  await db
    .prepare(
      `UPDATE consultations SET delivery = 'delivered', error = NULL
       WHERE id = ? AND status = 'sent' AND delivery IN ('pending', 'unknown')`,
    )
    .bind(id)
    .run();
}

/** Delete expired consultations (called by the daily cron). Returns the number deleted. */
export async function purgeExpired(db: D1Database, now = new Date()): Promise<number> {
  const result = await db.prepare(`DELETE FROM consultations WHERE created_at <= ?`).bind(retentionCutoff(now)).run();
  return result.meta.changes;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Reply token valid for one consultation only. Sent to the Grok Bot in the webhook body. Expiry is checked in the DB. */
export async function signReplyToken(secret: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`grok-reply:${id}`)));
}

export async function verifyReplyToken(secret: string, id: string, token: string): Promise<boolean> {
  return secretEqual(await signReplyToken(secret, id), token);
}
