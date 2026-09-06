/**
 * The shape of the harvested store, as one reviewable unit.
 *
 * Kept apart from the module that opens the database so the schema can be read
 * end to end without the connection handling in the way.
 *
 * `STRICT` on every table: SQLite's default type affinity would silently accept
 * a string where a count belongs, and this store exists to make claims about
 * counts. It has no BOOLEAN, so flags are 0/1 integers decoded explicitly on
 * the way out (see store-rows.ts) rather than cast.
 */

/** Bumped only by a migration in store-migrations.ts. Independent of the server's semver. */
export const STORE_VERSION = 1;

export const STORE_PRAGMAS = [
  // One writer and many readers across processes, which rollback journalling
  // cannot do. Required for the "kill the server mid-harvest" guarantee.
  'PRAGMA journal_mode = WAL',
  // A crash loses at most the last committed transaction and can never corrupt
  // the file. FULL would fsync per commit for a store whose worst case is
  // re-fetching one video.
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
] as const;

export const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS channel (
  channel_id       TEXT PRIMARY KEY,
  handle           TEXT    NOT NULL DEFAULT '',
  name             TEXT    NOT NULL DEFAULT '',
  channel_url      TEXT    NOT NULL DEFAULT '',
  subscriber_count INTEGER,
  description      TEXT    NOT NULL DEFAULT '',
  avatar_url       TEXT,
  banner_url       TEXT,
  first_seen_at    INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS video (
  video_id      TEXT PRIMARY KEY,
  channel_id    TEXT REFERENCES channel(channel_id) ON DELETE CASCADE,
  title         TEXT    NOT NULL DEFAULT '',
  duration_s    INTEGER,
  -- 'YYYY-MM-DD'. NULL, never '', when a flat listing carried none: a date
  -- filter must be able to tell "not known yet" from "known to be empty".
  upload_date   TEXT,
  view_count    INTEGER,
  like_count    INTEGER,
  -- YouTube's own claim, read WITHOUT --write-comments, which overwrites it
  -- with the number extracted. This is the denominator every comment receipt
  -- is measured against, so it may only ever come from a metadata pass.
  comment_count INTEGER,
  live_status   TEXT,
  availability  TEXT,
  thumbnail_url TEXT,
  tab           TEXT,
  also_in_tabs  TEXT    NOT NULL DEFAULT '[]',
  catalog_rank  INTEGER,
  listed_at     INTEGER,
  detail_at     INTEGER,
  -- Stripped before storage: formats, automatic_captions, subtitles,
  -- thumbnails and comments are 96% of a raw -j payload and are mostly
  -- expiring URLs. See MAX_DETAIL_JSON_BYTES.
  detail_json   TEXT,
  heatmap_json  TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS video_by_channel ON video(channel_id, catalog_rank);
CREATE INDEX IF NOT EXISTS video_by_date    ON video(channel_id, upload_date DESC);

CREATE TABLE IF NOT EXISTS comment (
  comment_id         TEXT PRIMARY KEY,
  video_id           TEXT    NOT NULL REFERENCES video(video_id) ON DELETE CASCADE,
  -- NULL for a top-level comment. yt-dlp writes the string 'root'; normalising
  -- it here means a reply count is a COUNT(parent_id) rather than a filter
  -- everyone has to remember.
  parent_id          TEXT,
  text               TEXT    NOT NULL DEFAULT '',
  like_count         INTEGER NOT NULL DEFAULT 0,
  author             TEXT    NOT NULL DEFAULT '',
  author_id          TEXT,
  author_url         TEXT,
  author_thumbnail   TEXT,
  author_is_uploader INTEGER NOT NULL DEFAULT 0,
  author_is_verified INTEGER NOT NULL DEFAULT 0,
  is_pinned          INTEGER NOT NULL DEFAULT 0,
  is_favorited       INTEGER NOT NULL DEFAULT 0,
  time_text          TEXT,
  published_at       INTEGER,
  harvested_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS comment_by_video  ON comment(video_id, parent_id, like_count DESC);
CREATE INDEX IF NOT EXISTS comment_by_parent ON comment(parent_id);
CREATE INDEX IF NOT EXISTS comment_by_author ON comment(author_id);
CREATE INDEX IF NOT EXISTS comment_by_time   ON comment(video_id, published_at);

CREATE VIRTUAL TABLE IF NOT EXISTS comment_fts USING fts5(
  text,
  content       = 'comment',
  content_rowid = 'rowid',
  tokenize      = "unicode61 remove_diacritics 2"
);

-- Triggers rather than a periodic 'rebuild'. Measured: triggers cost 6.2x on
-- bulk insert (2.3s vs 366ms per 200k rows) while 'rebuild' is O(whole table)
-- and would take seconds per checkpoint at millions of rows. Against a network
-- that delivers ~17 comments/second, the trigger cost is noise, and there is no
-- "did we remember to rebuild" failure mode.
CREATE TRIGGER IF NOT EXISTS comment_ai AFTER INSERT ON comment BEGIN
  INSERT INTO comment_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS comment_ad AFTER DELETE ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS comment_au AFTER UPDATE ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO comment_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- What this store can prove about one target. Written in the SAME transaction
-- as the rows it describes, so there is no interval in which a receipt can
-- claim something the store does not hold.
CREATE TABLE IF NOT EXISTS harvest_receipt (
  scope             TEXT    NOT NULL,
  target_id         TEXT    NOT NULL,
  state             TEXT    NOT NULL,
  reason            TEXT    NOT NULL,
  have              INTEGER NOT NULL DEFAULT 0,
  -- What the SOURCE stated. NULL when it stated nothing; never derived from
  -- 'have', which would turn "we stopped" into "there was nothing more".
  expected          INTEGER,
  expected_source   TEXT,
  source            TEXT    NOT NULL,
  limit_applied     INTEGER,
  sort_applied      TEXT,
  ran_to_exhaustion INTEGER,
  resume_token      TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  note              TEXT,
  PRIMARY KEY (scope, target_id)
) STRICT;

CREATE INDEX IF NOT EXISTS receipt_by_state ON harvest_receipt(state, finished_at DESC);

-- Append-only audit trail: cheap, and it is what makes a receipt defensible
-- after the fact rather than merely asserted.
CREATE TABLE IF NOT EXISTS harvest_event (
  event_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope     TEXT    NOT NULL,
  target_id TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  state     TEXT    NOT NULL,
  delta     INTEGER NOT NULL DEFAULT 0,
  note      TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS event_by_target ON harvest_event(scope, target_id, at DESC);
`;
