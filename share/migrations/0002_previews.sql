-- What a shared replay's link preview shows: its players (a JSON array, one name
-- per side), length in frames and game version, read from the replay, and the
-- card picture its sharer's browser drew.
ALTER TABLE replays ADD COLUMN players TEXT;
ALTER TABLE replays ADD COLUMN frames INTEGER;
ALTER TABLE replays ADD COLUMN version TEXT;
ALTER TABLE replays ADD COLUMN card BLOB;
