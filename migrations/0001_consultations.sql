-- Consultations sent from an AI client to the Grok Bots, and their replies.
CREATE TABLE IF NOT EXISTS consultations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  -- sent: waiting for a reply / answered: reply received / failed: webhook refused, or the bots could not answer
  status TEXT NOT NULL,
  reply TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS consultations_created_at ON consultations (created_at DESC);
