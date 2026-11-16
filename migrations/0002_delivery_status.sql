-- Webhook delivery, kept separately from the reply status.
-- pending: being sent / delivered: accepted with 2xx / unknown: not confirmed (keep waiting) / rejected: clearly refused with 4xx
ALTER TABLE consultations ADD COLUMN delivery TEXT NOT NULL DEFAULT 'pending';
