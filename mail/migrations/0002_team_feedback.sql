-- Cerulean News team feedback: who may sign in, and the votes they cast.
-- Additive: nothing from 0001 changes. Times are Unix seconds.
--
-- A team member is anyone who proved control of an address at bcbsvt.com by
-- opening an emailed sign-in link, or an address on the ADMIN_EMAILS secret.
-- No row exists until that first sign-in. Admin rights are not stored here:
-- they come from the secret on every request. blocked is only ever set by
-- hand, with the wrangler command in mail/README.md.

CREATE TABLE team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Lowercase. For bcbsvt.com addresses, the canonical form without a +tag.
  email TEXT NOT NULL UNIQUE,
  -- A blocked address (never an admin) cannot sign in, and its votes leave the pipeline export.
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  -- Carried by every session cookie. Sign-out raises it, which ends every
  -- session for this address.
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_signin_at INTEGER
);

-- Sign-in links already used. A link is single use because its nonce is
-- inserted here on first use and the insert fails the second time.
CREATE TABLE signin_links (
  nonce TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- One current vote per (member, story). item_id is the SHA-256 URL hash the
-- pipeline uses for the editorial rejection list (exampleId in
-- src/jev-examples.js), so a vote maps back to a feed item without a URL.
-- label is the corrected sentiment, only ever on a 'sentiment' vote, and one
-- of the site's five labels.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES team_members (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL CHECK (length(item_id) = 64),
  vote TEXT NOT NULL CHECK (vote IN ('keep', 'drop', 'sentiment')),
  label TEXT CHECK (label IS NULL OR label IN (
    'positive', 'neutral to positive', 'neutral', 'neutral to negative', 'negative'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (member_id, item_id),
  CHECK ((vote = 'sentiment') = (label IS NOT NULL))
);

CREATE INDEX idx_feedback_updated_at ON feedback (updated_at);
