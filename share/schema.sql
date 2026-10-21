-- A shared replay, stored under the first 16 hex characters of its SHA-256.
-- `owner` is the SHA-256 of the token that lets the sharer remove it.
CREATE TABLE IF NOT EXISTS replays (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  owner TEXT NOT NULL,
  created INTEGER NOT NULL
);
