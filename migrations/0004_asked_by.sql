-- Who asked: the AI client's self-reported name (the "from" tool argument),
-- or the OAuth client's registered name. Shown to the Grok Bot as "from".
ALTER TABLE consultations ADD COLUMN asked_by TEXT;
-- The public base URL the consultation was created under. Cron resends have no request to
-- derive it from, so they use this when PUBLIC_URL is not configured.
ALTER TABLE consultations ADD COLUMN reply_base_url TEXT;
-- At most how many other bots the receiving bot should ask (optional; NULL lets the routine decide).
ALTER TABLE consultations ADD COLUMN max_bots INTEGER;
