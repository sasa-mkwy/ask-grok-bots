-- Automatic resends of consultations without a reply.
-- attempts: webhook sends so far, the first one included
-- last_sent_at: time of the last send; NULL means only the first send (use created_at)
ALTER TABLE consultations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE consultations ADD COLUMN last_sent_at TEXT;
