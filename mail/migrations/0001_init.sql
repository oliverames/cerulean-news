-- Cerulean News mail: subscribers, per-list subscriptions, the send log, job
-- state, and the per-IP rate limiter. Times are Unix seconds. Only the email
-- address, the chosen lists, and the send log identify anyone; the rate
-- limiter stores a salted hash of the IP address, never the address itself.

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  -- pending: never confirmed. active: confirmed and receiving mail.
  -- unsubscribed: opted out (a later subscribe needs a fresh confirmation).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'unsubscribed')),
  -- Lists requested but not yet confirmed, comma separated, and the single-use
  -- nonce carried by the newest confirmation link.
  pending_lists TEXT,
  confirm_nonce TEXT,
  confirm_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_subscribers_status ON subscribers (status);

-- One row per confirmed list. Rows are removed on unsubscribe.
CREATE TABLE subscriptions (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  list TEXT NOT NULL CHECK (list IN ('digest', 'alerts', 'monthly')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, list)
);

CREATE INDEX idx_subscriptions_list ON subscriptions (list);

-- The send log. A row is claimed before the message goes out, so a given
-- content_key (an alert batch id, a digest date, a report month) reaches a
-- subscriber at most once. Statuses: sending (claimed, outcome unknown, never
-- retried), sent, suppressed (Email Service refused a suppressed address), and
-- failed (retried on the next run until attempts reaches the cap).
CREATE TABLE sends (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  list TEXT NOT NULL,
  content_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'suppressed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  message_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, list, content_key)
);

CREATE INDEX idx_sends_created_at ON sends (created_at);

-- Delivery progress per content item, so a run that hit the per-run cap or a
-- sending limit is resumed by a later cron tick.
CREATE TABLE jobs (
  list TEXT NOT NULL,
  content_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('partial', 'done')),
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (list, content_key)
);

-- Fixed-window counters. key is a salted hash (or a global label).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
