import { type Env, codePointLength, signingSecretOk } from "./env";
import { getConsultation, saveReply, verifyReplyToken } from "./store";
import { sendReplyNotice } from "./notify";

export const MAX_REPLY_CHARS = 30000;
const MAX_REPLY_BODY_BYTES = 128 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/**
 * Read the body as UTF-8, counting bytes as they stream in. Returns null as soon as it exceeds maxBytes
 * (without buffering the rest), so the limit holds even without a Content-Length header.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Where the Grok Bot POSTs its answer. Authenticated with the per-consultation signed token. */
export async function handleReply(
  request: Request,
  env: Env,
  id: string,
  waitUntil: (promise: Promise<unknown>) => void = () => {},
): Promise<Response> {
  if (!signingSecretOk(env)) {
    console.log("reply refused: REPLY_SIGNING_SECRET is missing or too short");
    return json({ error: "server misconfigured" }, 500);
  }
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !(await verifyReplyToken(env.REPLY_SIGNING_SECRET, id, token))) {
    return json({ error: "unauthorized" }, 401);
  }
  const c = await getConsultation(env.DB, id);
  if (!c) return json({ error: "consultation not found or expired" }, 404);
  if (c.status !== "sent") return json({ error: `already ${c.status}` }, 409);
  // Delivery does not matter: if the webhook timed out but the body arrived, the reply is still accepted.

  if (Number(request.headers.get("Content-Length")) > MAX_REPLY_BODY_BYTES) {
    return json({ error: "body too large" }, 413);
  }
  const raw = await readBodyLimited(request, MAX_REPLY_BODY_BYTES);
  if (raw === null) return json({ error: "body too large" }, 413);

  let reply: string | undefined;
  let failed = false;
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType === "application/json") {
    try {
      const body = JSON.parse(raw) as { reply?: unknown; content?: unknown; status?: unknown };
      const value = body.reply ?? body.content;
      reply = typeof value === "string" ? value : undefined;
      failed = body.status === "failed";
    } catch {
      return json({ error: 'invalid JSON. Send {"reply": "..."}' }, 400);
    }
  } else {
    reply = raw;
  }
  reply = reply?.trim();
  if (!reply) return json({ error: 'empty reply. Send {"reply": "..."}' }, 400);
  if (codePointLength(reply) > MAX_REPLY_CHARS) return json({ error: `reply exceeds ${MAX_REPLY_CHARS} characters` }, 413);

  // The UPDATE itself enforces expiry and status (also catches expiry or a race after the checks above).
  const saved = await saveReply(env.DB, id, reply, failed);
  if (saved === "not_found") return json({ error: "consultation not found or expired" }, 404);
  if (saved === "already_closed") return json({ error: "already answered" }, 409);
  console.log("grok reply saved", { id, failed, chars: reply.length });
  // After the response, so a slow receiver never delays the bot.
  waitUntil(sendReplyNotice(env, { consultation_id: id, title: c.title, status: failed ? "failed" : "answered" }));
  return json({ ok: true });
}
