# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-08-14

### Added

**Channel brains.** `build_brain` reads a whole channel into a searchable corpus
of timestamped passages, and `ask_brain` answers questions from what the creator
actually said — returning the moments themselves, each with the second it was
spoken and a link that opens the video there. Alongside them: `list_brains`,
`get_brain_info`, `save_brain_profile` and `delete_brain`, the
`youtube://brain/{channelId}/{manifest|profile}` resource, and the `create_brain`
and `ask_creator` prompts. All local (stdio) only, like the library.

Reading several hundred videos means several hundred fetches, so a build is
something that gets interrupted. Per-video state is recorded in a manifest and
checkpointed as it goes, and a cancelled build saves what it read before it
stops: an interrupted, throttled or killed build leaves a valid brain, and
calling `build_brain` again continues where it stopped.

The manifest and the passages are two documents, and only one can be written
first. Rather than trust that they agree, every build reconciles them: a video
the corpus cannot account for goes back to pending and is read again on that
same call. A brain cannot be stranded claiming to hold videos it can no longer
search, and there is no repair tool to remember to run. That is also
the refresh path — on a finished brain it reads only what is new — so there is no
separate refresh tool. A video with no captions, or one behind a members-only
wall, costs itself and nothing else.

Filters are re-evaluated rather than remembered, and every value they test is
one YouTube reported for that video. A channel listing is fetched flat — which
is what makes enumerating a thousand videos one request rather than a thousand —
and flat entries carry no publication date, so dates and lengths come from each
video's own metadata, in the same request that fetches its chapters. A video the
filters rule out costs that one request and no transcript.

The server has no language model and does not pretend otherwise. It counts what
can be counted — coverage, upload rhythm, speaking rate, phrases repeated across
videos — and leaves the reading of a creator to `save_brain_profile`, which
stores an account written from passages that can be cited.

### Fixed

**`search_library` reported the size of the page as the size of the result set.**
`total` was the number of hits returned, so `hasMore` was always false and a
caller was told there was nothing more when there might be forty more matches.
Both search tools now report the real match count and accept an `offset`, so the
`nextOffset` they hand back points at a parameter that exists.

**JSON documents could be truncated by an interrupted write.** The library index,
the search index and every note's metadata were written straight to their
destination, so a process that died mid-write left a corrupt file where a valid
one had been. They now go through a temporary file and a rename, which is atomic.

**`libraryMetadataSchema` was declared twice**, in `schemas.ts` and in
`storage.ts`, and the two were free to drift. The location of the data directory
was spelled out in six places. Both are now single-sourced.

## [2.0.2] - 2026-08-12

### Fixed

**The server could wedge until it was restarted.** Reported in the field on
`extract_clip`, but no tool was safe: once it happened, every yt-dlp call queued
behind it for good.

Two defects had to meet. Media transfers run without a wall-clock timeout, on
purpose — a long clip should take as long as it honestly takes — so a stalled
connection was indistinguishable from a slow one and held its concurrency slot
indefinitely. And the wait for a slot was a bare promise with no way out: it
ignored the request's abort signal, so a client that gave up stayed queued for
ever. Three stalled transfers therefore held every slot, and everything after
them waited on a queue nothing would ever drain. The server was not slow, it
was locked, and cancelling did not help.

- Waiting for a slot now honours the abort signal: a cancelled request leaves
  the queue and reports `CANCELLED` instead of hanging. Covered by a test that
  times out against the previous code.
- Every yt-dlp call passes `--socket-timeout`, so a dead connection fails
  instead of holding its slot. This bounds silence, not work — a transfer still
  making progress is never interrupted, and transfers keep their absent
  wall-clock timeout.
- Releasing a slot hands it to the next waiter rather than freeing it and
  letting callers race, which used to let the limiter run over its own ceiling
  for a tick.

**`npm run validate` now runs the coverage gate.** It ran the tests without
coverage while CI ran them with it, so the per-file thresholds — the check that
actually fails a build — were invisible locally, and the README's claim that CI
runs the same gate was not true.

**Setting `MCP_ALLOWED_HOSTS` made the service permanently unhealthy.** The SDK
installs Host validation as global middleware, so `/health` sat behind the
allowlist too. A probe reaches it over loopback with `Host: 127.0.0.1:<port>`,
which an allowlist naming a public hostname does not contain — so the container's
own `HEALTHCHECK`, and every platform probe, got 403 while the server answered
real traffic perfectly. The advice to set that variable, added in the same
breath as the Blueprint, would have bricked the deployment it was meant to
harden.

`/health` is now mounted ahead of the MCP app, so it answers probes while
everything else keeps the allowlist intact. It exposes binary versions and a
session count, which is not what a Host allowlist protects. Covered by a test
that fails against the previous arrangement.

**A single lost probe pinned `/health` to 503 for the process lifetime.**
`runPreflight` cached failures with no expiry, so a `yt-dlp --version` that
timed out once at boot — plausible on a cold, small instance — left the report
`ok: false` for good. The deploy then never went live on a platform that would
have retried. Successful reports still hold for the process lifetime; failed
ones expire after a minute, rather than re-probing on every request and letting
a slow host stack overlapping spawns.

**The Docker image could never report healthy.** The `HEALTHCHECK` polled
`PORT || 10000` while the application defaults to 3000, so outside a platform
that injects `PORT` the check failed forever and the container sat `unhealthy`
while serving traffic normally. The same mismatch made the documented
`docker run -p 3000:10000` publish a port nothing listened on.

The image now sets `PORT=10000`, matching its own `EXPOSE` and health check;
platforms that inject a port still override it. Verified by running the health
check command exactly as written inside the container — it exited 1 before this
change and 0 after, and `docker inspect` reports `healthy`.

### Added

**One-click deployment of your own instance.** [`render.yaml`](render.yaml) and a
Deploy to Render button in the README. The Blueprint builds the image, points
the health check at `/health` and generates an `MCP_AUTH_TOKEN`, so a remote
deployment requires a bearer token from the first request rather than starting
open and waiting to be secured.

There is no shared instance of this server, and the README now says so: every
call shells out to yt-dlp, so one host serving everyone's traffic is one host
YouTube rate-limits for everyone.

The Blueprint sets `autoDeployTrigger: off`. The button wires the service to
this repository, which the person deploying does not control; auto-deploying
would run every future commit pushed here inside their account, under their
generated token, with nobody reading it first. Taking a newer version is a
Manual Deploy they choose.

## [2.0.1] - 2026-08-12

### Fixed

**The server started, then exited without a word.** 1.2.0 and 2.0.0 were unusable
through `npx` — which is how the README, and every MCP client configuration,
starts this server. The process connected, received `initialize`, and exited 0
with nothing on stderr. 1.1.1 was unaffected.

1.2.0 wrapped `main()` in a guard so that importing the module from the test
suite would not spawn a transport:

```js
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
```

npm installs a package's `bin` as a symlink in `node_modules/.bin`, and `npx`
runs that link. Node reports the link in `process.argv[1]` but resolves
`import.meta.url` to the file it points at, so the two are never equal and
`main()` never ran. Launching the entry point by its real path — which is what
the smoke test did — made the comparison succeed, so CI stayed green through
two releases.

- The `bin` entry is now `dist/cli.js`, a file whose only job is to call
  `main()`. It has nothing to detect, so there is no comparison left to get
  wrong. `index.ts` still starts nothing on import, which is what the guard was
  there for.
- The smoke test repeats the whole handshake through a symlink to the entry
  point. Checked against the broken 2.0.0 build: direct launch lists 27 tools,
  the symlinked launch fails — the new check would have caught this before
  release.
- `npm start`, `npm run start:http` and the Docker image's `CMD` follow the
  entry point to `dist/cli.js`.

## [2.0.0] - 2026-08-12

### Changed

**Node 22 is the floor.** Node 20 reached end of life in April 2026 and the
project was still testing against it, which is the one version a security fix
will never reach. Supporting it also had a running cost: `execa` and
`lint-staged` were held back at majors that honour `>=20`, and `node:sqlite` was
off the table.

- `engines.node` is `>=22.0.0`. Installing on Node 20 now fails at install time
  rather than at runtime, because `.npmrc` sets `engine-strict=true`.
- CI runs the matrix on Node 22 and 24; the Docker image ships Node 24.
- `.nvmrc` pins 24 — the active LTS — and is the single source for every
  single-version job, so the release workflow and the local toolchain cannot
  drift apart again.

This is breaking for anyone running Node 20, hence the next release is 2.0.0.
Nothing else about the API changes: no tool, parameter or output is affected.

**Dependencies held back by that floor moved up.** `execa` 10 and `lint-staged`
17 both require Node 22 and were pinned to older majors — and blocked in
Dependabot — for as long as the package claimed to run on 20.

- `execa` 10 removes `execaCommand()` and stops exposing `ChildProcess`
  directly. Neither is used here: every call is `execa(command, args, options)`
  reading `stdout`, and failures are read off `ExecaError`. Verified against
  real yt-dlp runs, since the unit suite mocks execa: metadata comes back
  intact, and a missing binary still surfaces as `YTDLP_MISSING` rather than a
  raw spawn error.

## [1.2.0] - 2026-08-12

Additive throughout: every tool from 1.1.1 keeps its name, its parameters and
its text output, and nothing that used to default has become required. A
snapshot test enforces this.

### Added

**Transcripts keep their timestamps.** The parser previously discarded every
cue timing and returned one flat string, so a model could quote a three-hour
video but never say when something was said.

- `get_transcript` gains `format` (`text` | `timestamped` | `segments`),
  `startTime`/`endTime` and `chapter` slicing, `maxChars`/`offset` windowing,
  and `refresh`. All optional; the default output is unchanged.
- `search_transcript` finds a phrase or pattern inside a video and returns each
  match with its timestamp and a `?t=` link. Matching spans caption boundaries,
  so a phrase split across two cues is still found.
- `get_transcripts` and `digest_playlist` handle many videos in one call, under
  the shared concurrency limit and with progress reporting.

**Clip and excerpt extraction**, for editing workflows.

- `extract_clip` cuts a time range — by timestamp or chapter name — fetching
  only the byte range that covers it rather than the whole video.
- `extract_audio_clip`, `extract_clips` (batch), `extract_frame` and
  `export_subtitles` (SRT / WebVTT / plain text).

**The library can be read.** It was previously write-only.

- `get_library_item`, `search_library` (full-text, ranked), `update_library_tags`,
  `delete_library_item` and `rebuild_library_index`.
- Search is a self-contained BM25 index; no new runtime dependencies.

**MCP protocol surface.**

- Every tool declares an `outputSchema` and returns `structuredContent`.
- Tools that write files return a `resource_link` block alongside the path.
- Seven prompts, two resource templates, argument completion, the logging
  capability, and progress notifications.

**Reliability.**

- `check_health` reports yt-dlp and ffmpeg presence, version and staleness. The
  same check runs at startup and reports to stderr without blocking the server.
- Typed error codes with an actionable next step, replacing raw yt-dlp stderr.

### Changed

- Every yt-dlp call now has a timeout, honours the request's cancellation
  signal, retries transient failures with exponential backoff, and runs under a
  concurrency limit. Previously none of these existed and a hung yt-dlp hung the
  tool indefinitely.
- Unrecognised yt-dlp stderr is never forwarded to the client; it routinely
  contains the full command line and local paths.
- WebVTT is parsed by `webvtt-parser`, the W3C reference implementation, rather
  than by hand-written expressions. WebVTT has a real grammar — cue settings,
  inline timestamps, `<c>` spans, escapes — and an approximation of it silently
  returns wrong text rather than failing.
- Why a video cannot be read is now determined from yt-dlp's structured
  `availability` and `live_status` fields, which are closed sets yt-dlp itself
  defines, rather than from the text it prints. The text is not yt-dlp's: it is
  YouTube's `playabilityStatus.reason`, re-raised verbatim, so it is localised
  to the server's account and rewritten whenever YouTube changes its copy.
  Matching on it produced confident, unverifiable answers. Metadata lookups pass
  `--ignore-no-formats-error` so those fields are populated for a refused video
  instead of extraction aborting. What is still read out of stderr is limited to
  sentences yt-dlp constructs itself, each carrying a source citation.
- Error codes track what can actually be produced: `PREMIUM_ONLY` and
  `LOGIN_REQUIRED` are added, and `BOT_CHECK`, `NETWORK`, `REGION_BLOCKED` and
  `REMOVED` are removed — nothing could emit them without guessing at YouTube's
  wording.
- HTTP transport: opt-in bearer authentication (`MCP_AUTH_TOKEN`), configurable
  Origin/Host allowlists, idle session expiry and a session cap, `Retry-After`
  on 429, and SIGTERM handling. Authentication is off by default so existing
  deployments keep working.
- `hasTranscript` in library metadata now reflects reality; it was hardcoded
  `false`.
- Transcripts are cached in a versioned format with a 30-day TTL. Caches written
  by earlier versions are regenerated rather than misread.
- Output directories are confined to the user's home directory.
- Docker image is multi-stage, runs as a non-root user, pins yt-dlp, and has a
  `HEALTHCHECK`.
- Dependencies updated; reported vulnerabilities went from 19 to 0. Linting
  fails on warnings, and `noUncheckedIndexedAccess` is enabled — which surfaced
  23 latent bugs, all fixed.

### Fixed

- The package no longer claims Node 20 support while being unable to run there.
  execa 10 and lint-staged 17 both require Node 22, and npm installed them
  without complaint against an `engines` field of `>=20`; the break surfaced
  only as `TEXT_ENCODINGS.union is not a function` from inside execa on the
  oldest supported Node. Both are pinned to versions that honour the declared
  floor, and `.npmrc` now sets `engine-strict=true` so a future mismatch fails
  at install time instead of at runtime.
- Tool names are now uniformly verb-first. `health_check` was the one noun-first
  name and is `check_health`; it was introduced in this release and never
  published, so nothing external depended on it. Tests now enforce both halves
  of the convention: every name starts with a verb, and no name carries a
  service prefix — MCP clients already namespace tools by server, so a
  `youtube_` prefix would repeat what the client knows on every request.
- Tool annotations no longer understate what a tool does. `save_to_library` and
  `update_library_tags` are now marked `destructiveHint: true` — the first
  overwrites an existing note in place, the second discards every tag when
  `replace` is used — and `download_video` is marked `idempotentHint: true` to
  agree with the `extract_*` tools, which write to a deterministic path in
  exactly the same way. A client uses these hints to decide whether to confirm
  before acting, so understating the risk is worse than omitting the hint. A
  test now enforces the underlying invariant: any tool whose description admits
  to overwriting, deleting or discarding must be marked destructive.
- Everything read back from disk or from yt-dlp is validated with a schema
  rather than asserted with a type cast. A transcript cache was previously
  accepted after checking only that `segments` was an array, so a truncated or
  hand-edited file was returned as if it were sound and its missing timings
  reached deep-link building as `undefined`; the library index was accepted
  without validating any entry. A corrupt entry now costs that one note instead
  of the whole library, and an unreadable cache is refetched.
- A cancelled request is reported as `CANCELLED`. The abort escaped as a bare
  `AbortError`, which was normalised into a generic tooling failure telling the
  client to check its yt-dlp install — for a request the client itself
  cancelled.
- An HTTP request carrying `Mcp-Session-Id` twice is no longer reported as an
  invalid session. Node parses a repeated header into an array, which was
  asserted to be a string and then matched no session at all.
- Prompt argument completion now works. `review_library` offers completions over
  the tags actually saved, but the marker was attached to the optional wrapper
  rather than to the schema inside it, so the capability was never advertised
  and a client asking for completions got "method not found".
- `get_video_info` no longer mis-parses a short row from yt-dlp; view, like and
  comment counts silently read as 0 when fields were absent.
- Download format precedence: a quality preset now unambiguously wins over
  `formatId`, and transfers are no longer retried over a partial file.
- A malformed row in a multi-line yt-dlp response no longer discards the whole
  result set.

### Infrastructure

- CI on every push and pull request across Node 20, 22 and 24, with a
  post-build smoke test that boots the server as a real MCP client.
- 24 tests to 627, including protocol-level tests over an in-memory transport, a
  manifest snapshot, and library tests against a real filesystem. Coverage is
  99% of lines and 98% of statements, enforced per file as a ratchet. What is
  left uncovered is the process entry point — exercised out of process by the
  post-build smoke test — and a few defensive guards against states that cannot
  occur.
- Dependabot, CODEOWNERS, SECURITY.md, a scheduled yt-dlp bump, and this
  changelog.

## [1.1.1] - 2025-11-15

### Fixed

- Missing `viewCount`, `likeCount`, and `commentCount` in test mocks.

## [1.1.0]

### Added

- Remote MCP support over Streamable HTTP, six new tools, and MCP tool
  annotations.
- Tests for all tools; tool parameters harmonized to camelCase.

## [1.0.2]

### Fixed

- Video and audio streams now merge correctly in MP4 downloads.

## [1.0.0]

Initial release.

[unreleased]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/teobouancheau/youtube-knowledge-mcp/releases/tag/v1.1.1
