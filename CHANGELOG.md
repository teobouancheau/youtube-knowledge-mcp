# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0]

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

- `health_check` reports yt-dlp and ffmpeg presence, version and staleness. The
  same check runs at startup and reports to stderr without blocking the server.
- Typed error codes with an actionable next step, replacing raw yt-dlp stderr.

### Changed

- Every yt-dlp call now has a timeout, honours the request's cancellation
  signal, retries transient failures with exponential backoff, and runs under a
  concurrency limit. Previously none of these existed and a hung yt-dlp hung the
  tool indefinitely.
- Unrecognised yt-dlp stderr is never forwarded to the client; it routinely
  contains the full command line and local paths.
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

- Tool annotations no longer understate what a tool does. `save_to_library` and
  `update_library_tags` are now marked `destructiveHint: true` — the first
  overwrites an existing note in place, the second discards every tag when
  `replace` is used — and `download_video` is marked `idempotentHint: true` to
  agree with the `extract_*` tools, which write to a deterministic path in
  exactly the same way. A client uses these hints to decide whether to confirm
  before acting, so understating the risk is worse than omitting the hint. A
  test now enforces the underlying invariant: any tool whose description admits
  to overwriting, deleting or discarding must be marked destructive.
- `get_video_info` no longer mis-parses a short row from yt-dlp; view, like and
  comment counts silently read as 0 when fields were absent.
- Download format precedence: a quality preset now unambiguously wins over
  `formatId`, and transfers are no longer retried over a partial file.
- A malformed row in a multi-line yt-dlp response no longer discards the whole
  result set.

### Infrastructure

- CI on every push and pull request across Node 20, 22 and 24, with a
  post-build smoke test that boots the server as a real MCP client.
- 24 tests to 328, including protocol-level tests over an in-memory transport, a
  manifest snapshot, and library tests against a real filesystem. Coverage
  thresholds are enforced.
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

[unreleased]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/teobouancheau/youtube-knowledge-mcp/releases/tag/v1.1.1
