# Create Brain — Design

Date: 2026-08-14
Status: approved, pending implementation plan

## Summary

`create_brain` scrapes a YouTube channel and builds a durable, queryable corpus
of everything its creator has said, indexed by timestamp. Every answer drawn
from a brain cites a specific second of a specific video.

The brain is a **grounded knowledge base** first. A persona profile is a thin
derived layer on top, written by the client's model from real quotes, never
inferred by the server.

## Motivation

The server can already read one video deeply (`get_transcript`,
`search_transcript`) and survey a channel shallowly (`digest_playlist`,
`channel_deep_dive`). There is nothing between: no way to ask "what has this
creator ever said about X" without re-fetching and re-reading transcripts every
time, and no way to hold a 200-video channel without flooding the context
window.

A brain closes that gap. It is not a new subsystem — it layers on the existing
transcript cache, `SearchIndex`, and yt-dlp concurrency limiter.

## Architectural constraint

The MCP server has no LLM. It can spawn yt-dlp and rank text; it cannot
summarize, infer opinions, or write a persona. The work therefore splits:

- **The server does the mechanical half**: enumerate, fetch, chunk, index,
  compute statistics.
- **The client's model does the semantic half**, driven by an MCP prompt, and
  writes the result back through a tool.

Anything else means either fabricating a persona from thin data or embedding an
LLM call inside an MCP server, which this codebase deliberately avoids.

## Storage

```
~/.youtube-knowledge/brains/<channelId>/
├── manifest.json        channel metadata, per-video state, checkpoint, stats
├── chunks.json          timestamped passages
├── search-index.json    per-brain BM25, serialized SearchIndex
├── profile.md           model-written synthesis (optional)
└── build.lock           present only during a build
```

Keyed on `ChannelInfo.channelId` (`UC…`), not the handle, because handles get
renamed and a renamed handle would orphan a brain.

A **per-brain** index rather than entries in the global library index:

- keeps the library index small and its searches fast
- makes `delete_brain` an `rm -rf` with no index surgery
- lets `SearchIndex` be reused **unmodified** — a chunk already fits its
  document shape as `{ id: "<videoId>:<startSeconds>", videoId, title, kind:
'chunk', text }`

Brains are registered in **stdio mode only**, matching the library. In HTTP mode
any client could fill the server's disk with a 500-video scrape.

### Path safety

`channelId` originates from yt-dlp output and becomes a directory name. It is
validated against `/^UC[\w-]{22}$/` in `validate.ts` before any path join. A
value containing `../` would otherwise escape the brains directory. Invalid ids
raise `INVALID_INPUT`.

### Durability

Every JSON write goes through `writeJsonAtomic()` — write to `<file>.tmp`, then
`rename()`. The manifest is rewritten every `CHECKPOINT_EVERY_VIDEOS` videos
across a build that can run forty minutes; a direct write interrupted by a crash
leaves a truncated manifest and loses the whole build.

`storage.ts` has the identical latent failure on `index.json` and
`search-index.json` and adopts the same helper. This is in scope: it is the same
bug class in the code the brain builds on.

### Concurrency

A build takes `build.lock` containing `{ pid, startedAt }`. A second
`build_brain` on the same channel raises a typed error naming the running build.
A lock older than `LOCK_STALE_MS` is broken automatically, so a killed process
does not wedge the brain permanently. Without this, two interleaved builds
overwrite each other's manifest checkpoints and silently lose videos.

## Build pipeline

`build_brain({ channel, maxVideos, since?, minDurationSeconds? })`

1. `getChannelInfo(channel)` → resolve and validate `channelId`
2. `listVideos(channelUrl, maxVideos)` → enumerate. The function has no hard
   cap; only the tool schema bounds it.
3. Filter by `since` and `minDurationSeconds`
4. Diff against `manifest.videos` — process only `pending` and `failed`
5. Per video: `getTranscript` (hits the existing versioned transcript cache) and
   `getChapters`
6. Chunk the transcript, add chunks to the index, mark the video's state
7. Checkpoint the manifest every `CHECKPOINT_EVERY_VIDEOS` videos
8. Compute statistics, persist manifest and index, release the lock

Videos are processed with a fan-out of `MAX_CONCURRENT` (3), matching
`ytdlp.ts`, which already provides the limiter and exponential-backoff retry.
`throwIfAborted()` runs between videos; `reportProgress` reports throughout.

### Resumability

A cancelled, crashed, or rate-limited build leaves a valid manifest. Calling
`build_brain` again continues from where it stopped.

That same code path is the incremental refresh for new uploads, so there is no
separate `refresh_brain` tool.

Per-video state is `pending | indexed | no-captions | failed`, with the error
code recorded on failures. One dead video never aborts a 200-video build — the
same isolation `getTranscriptsHandler` already applies.

On repeated `RATE_LIMITED` classifications the build stops early and reports
partial, resumable state rather than continuing to hammer YouTube.

### Size guards

A single transcript is capped at `MAX_CHUNKS_PER_VIDEO` and a brain at
`MAX_CHUNKS_PER_BRAIN`. Exceeding either records the video as `failed` with a
clear reason rather than exhausting memory — the `MAX_OUTPUT_BYTES` precedent
in `ytdlp.ts`.

## Chunking

`utils/brain-chunks.ts` groups consecutive transcript segments into passages of
`CHUNK_TARGET_CHARS` (800, roughly 30–45 seconds of speech).

Break preference, in order:

1. a chapter boundary
2. a gap between segments longer than `CHUNK_BREAK_GAP_SECONDS` (2s), which in
   speech is a sentence or thought boundary
3. the target character count

Each chunk carries `videoId`, `title`, `startSeconds`, `endSeconds`, `text`.

No overlap between chunks. BM25 does not need it and overlap would require
dedup on retrieval for no gain.

## Retrieval

`ask_brain({ channel, query, limit })` ranks chunks with the existing BM25 index
and returns passages carrying `[MM:SS]`, video title, and a `&t=…s` deep link
built with the existing `deepLink()`.

This is the **only** path from the corpus into context. A 200-video brain is
roughly 30MB of transcript; nothing ever loads it wholesale. Every claim an
answer makes is checkable against a specific second of a specific video.

`storage.ts` reloads its index from disk on every search. For a brain that is up
to tens of megabytes of JSON per query, so the brain index loader memoizes on
`(channelId, mtimeMs)` and reloads only when the file actually changed.

## Statistics

Computed at the end of a build from the chunk corpus, all mechanical:

- video, indexed, no-captions and failed counts; chunk count; total words
- median words per minute
- first and last upload; uploads per month over time
- **recurring phrases**: 3-to-6-grams appearing in at least `PHRASE_MIN_VIDEOS`
  (3) distinct videos, which surfaces genuine catchphrases and recurring
  framings

Deliberately excluded:

- **Named-entity extraction.** Auto-generated captions are lowercase and
  unpunctuated, so capitalization heuristics produce garbage.
- **TF-IDF against a background corpus.** There is no honest background corpus
  to compare against, and inventing one would produce confident nonsense.

Fewer true numbers beat more plausible ones.

## Surface

### Tools

| tool                  | title                         | readOnly | destructive | idempotent | openWorld |
| --------------------- | ----------------------------- | -------- | ----------- | ---------- | --------- |
| `build_brain`         | Build a Channel Brain         | false    | false       | true       | true      |
| `ask_brain`           | Ask a Channel Brain           | true     | false       | true       | false     |
| `list_brains`         | List Channel Brains           | true     | false       | true       | false     |
| `get_brain_info`      | Get Channel Brain Details     | true     | false       | true       | false     |
| `save_brain_profile`  | Save a Channel Brain Profile  | false    | true        | true       | false     |
| `rebuild_brain_index` | Rebuild a Channel Brain Index | false    | false       | true       | false     |
| `delete_brain`        | Delete a Channel Brain        | false    | true        | true       | false     |

`save_brain_profile` is destructive because it overwrites `profile.md`, the same
reasoning that marks `update_library_tags` destructive for its `replace`
parameter. `build_brain` is idempotent because re-running converges on the same
brain rather than duplicating — that is the resume path. Only `build_brain`
touches the network, so it alone is open-world.

`rebuild_brain_index` rebuilds BM25 from `chunks.json` without re-scraping. It
mirrors `rebuild_library_index` and turns recovery from a corrupt index into a
two-second operation instead of a forty-minute re-scrape.

Every tool takes `channel` (URL, `@handle`, or name) and resolves it internally,
reusing the vocabulary `get_channel_info` already established. No new parameter
name is introduced for the same concept.

### Resources

- `youtube://brain/{channelId}/manifest` — `application/json`
- `youtube://brain/{channelId}/profile` — `text/markdown`

Both listable, enumerating brains actually on disk, following the
`library-item` resource pattern. Registered in stdio mode only.

### Prompts

- `create_brain(channel, limit)` — run `build_brain`, read `get_brain_info` for
  the statistics, probe the corpus with several `ask_brain` calls, synthesize,
  and persist through `save_brain_profile`
- `ask_creator(channel, question)` — retrieve, then answer strictly from
  retrieved passages, citing `[MM:SS]` and deep links, and say so explicitly
  when the corpus does not cover the question

The persona layer is exactly this: the client's model reads real quotes and
writes `profile.md`. The server never asserts anything about a person it cannot
quote.

## Schemas

Canonical brain shapes are declared once in `schemas.ts`, alongside the other
shared output shapes, and imported by the persistence layer for read-time
validation. They are not redeclared per module.

- `brainVideoStateSchema` — `{ videoId, title, uploadDate, durationSeconds,
state, chunkCount, error? }`
- `brainStatsSchema` — counts, word totals, median words per minute, upload
  range and rhythm, recurring phrases
- `brainSummarySchema` — channel identity, timestamps, `hasProfile`, headline
  counts
- `brainPassageSchema` — `{ videoId, title, startSeconds, startFormatted,
endSeconds, score, text, url }`
- `brainManifestSchema` — the on-disk document, composed from the above

`libraryMetadataSchema` currently exists in both `schemas.ts:108` and
`storage.ts:20`. `storage.ts` imports the shared one and deletes its copy, so
the brain follows a pattern that is actually single-source.

Every disk read is Zod-validated and corrupt-tolerant: an unreadable video entry
is dropped and rebuilt on the next `build_brain`, rather than failing the whole
brain — the behaviour `libraryIndexSchema` already establishes.

## Files

New:

- `src/utils/brain-storage.ts` — directories, manifest read/write, lock,
  per-brain index load/save with mtime memo, delete
- `src/utils/brain-chunks.ts` — segments to passages
- `src/utils/brain-stats.ts` — corpus statistics
- `src/utils/json-file.ts` — `writeJsonAtomic()`, shared with `storage.ts`
- `src/tools/build-brain.ts` — `build_brain`
- `src/tools/ask-brain.ts` — `ask_brain`
- `src/tools/brain-library.ts` — `list_brains`, `get_brain_info`,
  `save_brain_profile`, `rebuild_brain_index`, `delete_brain`

Split to stay under the 200-line ceiling.

Modified: `schemas.ts` (brain shapes), `index.ts` (registration), `resources.ts`
(brain resources), `prompts.ts` (brain prompts), `validate.ts` (channel id),
`storage.ts` (atomic writes, shared metadata schema), `CLAUDE.md` and
`CONTRIBUTING.md` (the `utils/` tree, which both carry).

Reused unmodified: `search-index.ts`, `transcript.ts`, `youtube.ts`,
`ytdlp.ts`, `errors.ts`, `context.ts`, `format.ts`.

## Error handling

All failures are `YouTubeError` with an existing code and a `nextStep`, matching
`errors.ts`:

- unresolvable channel → `NOT_FOUND`
- channel id failing validation → `INVALID_INPUT`
- brain not built yet, on `ask_brain` → `NOT_FOUND`, next step `build_brain`
- build already running → `INVALID_INPUT` naming the running build
- sustained throttling → `RATE_LIMITED`, with partial state reported and the
  resume instruction

No new error codes. Per-video failures are data in the manifest, not thrown
exceptions.

## Testing

vitest, with `npm run validate` enforcing coverage. No test spawns yt-dlp;
`tests/helpers.ts` and the `concurrencyState()` seam already establish that.

Unit:

- chunk boundaries — chapter splits, long silences, one giant segment, empty
  transcript
- manifest resume after a simulated abort mid-build
- atomic write leaves the previous file intact when interrupted
- lock acquisition, rejection, and staleness expiry
- statistics over a fixture corpus, including the n-gram threshold
- corrupt manifest and corrupt index recovery
- channel id validation rejecting traversal attempts

Tool level, against stubbed `listVideos` / `getTranscript` / `getChannelInfo`:

- a full build including a no-captions video and a failing video
- a second build picking up only new videos
- `ask_brain` returning passages with correct timestamps and deep links
- `delete_brain` removing everything, and being safe to call twice

Protocol level, extending `tests/protocol.test.ts` and `tests/manifest.test.ts`:
every brain tool declares title, description, input schema, output schema and
all four annotations, and brain tools are absent in HTTP mode.

## Scope boundaries

Cut deliberately:

- no embeddings or vector store — BM25 over one creator's vocabulary fits well
  and adds no dependency
- no comment ingestion
- no cross-brain queries
- no scheduled auto-refresh
- no `refresh_brain` tool; `build_brain` is the refresh
