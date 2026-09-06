# Contributing

Thanks for your interest in improving youtube-knowledge-mcp.

## Setup

```bash
git clone https://github.com/teobouancheau/youtube-knowledge-mcp.git
cd youtube-knowledge-mcp
nvm use          # or any Node matching .nvmrc
npm install
npm run build
```

The package itself runs on Node 22 or later, but the development toolchain
needs a little more: `lint-staged` requires 22.22.1. `.nvmrc` pins the active
LTS, and `engine-strict` in `.npmrc` means a Node older than a dependency
declares fails at install time rather than halfway through a commit.

You also need [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`, and
[ffmpeg](https://ffmpeg.org/) for downloads, clip extraction and frame capture.
Run the `check_health` tool at any time to confirm both are present and current
— an outdated yt-dlp is the most common cause of unexplained failures.

## Project structure

```
src/
├── cli.ts                # Executable entry (`bin`); never import it
├── index.ts              # Server construction and tool registration; safe to import
├── http.ts               # Streamable HTTP transport: process lifecycle and re-exports
├── http/
│   ├── config.ts         # Environment-driven HTTP configuration
│   ├── app.ts            # Express routes, auth and rate limiting
│   ├── auth.ts           # Bearer tokens, session ids, JSON-RPC errors
│   ├── rate-limiter.ts   # Fixed-window per-client counter
│   └── sessions.ts       # Live MCP sessions and their idle sweep
├── prompts.ts            # Reusable workflow prompts
├── resources.ts          # Transcript, library and brain resources
├── schemas.ts            # Shared Zod domain schemas
├── brain-schemas.ts      # The shapes a channel brain is made of
├── thumbnail-schemas.ts  # The shapes a channel's saved thumbnails are made of
├── thumbnail-resource.ts # The saved-thumbnails resource
├── prompts-shared.ts     # What every prompt needs
├── prompts-research.ts   # Prompts that survey more than one video
├── prompts-brain.ts      # Prompts for the channel brains
├── registry/             # Every tool as a record: types.ts and one file per group
├── tools/                # One file per tool group: input schema, output schema, handler
└── utils/
    ├── ytdlp.ts          # The only place yt-dlp is spawned
    ├── ytdlp-limiter.ts  # Concurrency cap every spawn passes through
    ├── ytdlp-parse.ts    # Guarded parsing of yt-dlp JSON
    ├── errors.ts         # Typed failure codes and stderr classification
    ├── preflight.ts      # yt-dlp / ffmpeg presence and staleness checks
    ├── pot-preflight.ts  # PO token providers, JS runtimes and impersonate targets
    ├── context.ts        # Per-request abort signal, progress and logging
    ├── transcript.ts     # WebVTT parsing, slicing and windowing
    ├── transcript-search.ts # Finding a phrase in a transcript
    ├── subtitles.ts      # SRT and WebVTT export
    ├── transcript-cache.ts # Fetching captions and keeping them on disk
    ├── caption-probe.ts  # Naming the caption languages a video does have
    ├── clips.ts          # Clip, audio and frame extraction
    ├── search-index.ts   # BM25 index, shared by the library and the brains
    ├── storage.ts        # Library persistence
    ├── json-file.ts      # Atomic JSON writes and validated reads
    ├── store-paths.ts    # Every file the harvested store is made of
    ├── store.ts          # The one node:sqlite connection: WAL, versioning, repair
    ├── store-schema.ts   # The store's DDL, as one reviewable unit
    ├── store-migrations.ts # Ordered schema migrations, one transaction each
    ├── store-rows.ts     # Zod-validated reads out of the store
    ├── store-health.ts   # What can be said about the store without harvesting
    ├── harvest-receipts.ts # Completeness receipts, persisted with their rows
    ├── harvest-catalog.ts # Walking every tab of a channel into the store
    ├── harvest-lock.ts   # Exclusive access to one harvest target
    ├── coverage.ts       # The only constructor for a completeness receipt
    ├── coverage-text.ts  # The receipt as the sentence a model reads
    ├── listing-cursor.ts # The opaque cursor fetch_videos hands back
    ├── comment-threads.ts # Flat comment rows rebuilt into threads
    ├── comment-store.ts  # Comments on disk, upserted and searchable
    ├── video-store.ts    # Reading the catalogued videos back
    ├── paths.ts          # The one directory everything is written under
    ├── brain-paths.ts    # Every file a brain is made of
    ├── brain-storage.ts  # Manifest and profile persistence
    ├── brain-lock.ts     # Exclusive access while a brain is being built
    ├── brain-chunks.ts   # Transcripts cut into retrievable passages
    ├── brain-ingest.ts   # Reading one video into passages
    ├── brain-build.ts    # Reading a channel, resumably
    ├── brain-index.ts    # Passage persistence and retrieval
    ├── brain-lookup.ts   # Finding a brain from whatever the channel was called
    ├── brain-phrases.ts  # Phrases a creator repeats across videos
    ├── brain-stats.ts    # What can be counted about a channel
    ├── thumbnail-paths.ts # Every file a channel's thumbnails are made of
    ├── thumbnail-store.ts # Thumbnail manifest persistence and lookup
    ├── thumbnail-ladder.ts # The best image YouTube will serve for one video
    ├── thumbnail-entry.ts # One thumbnail: recorded, fetched, saved
    ├── thumbnail-fetch.ts # Fetching a channel's thumbnails, resumably
    ├── thumbnail-listing.ts # Listing each channel tab for the fetch
    ├── image-fetch.ts    # The only HTTP client: allowlisted image hosts
    ├── image-dimensions.ts # Format and pixel size from an image's bytes
    ├── flat-listing.ts   # Reading a flat channel or playlist listing
    ├── channel-images.ts # Picking a channel's avatar and banner
    ├── channel-lookup.ts # Finding a channel's records from whatever it was called
    ├── file-lock.ts      # Exclusive access while a long job writes
    ├── batches.ts        # Running work a few items at a time
    ├── chapters.ts       # Resolving a chapter name to a chapter
    ├── pattern.ts        # Compiling a search pattern that cannot run away
    ├── guard.ts          # Request context and error normalisation for every handler
    ├── env.ts            # Reading configuration without trusting it
    ├── ytdlp-env.ts      # yt-dlp session options: cookies, proxy, pacing
    ├── version.ts        # The version this build reports
    ├── validate.ts       # Path, language, channel id and timestamp validation
    ├── validate-youtube.ts # Video ids, channel ids and YouTube URLs
    ├── format.ts         # Result construction and human-readable formatting
    ├── youtube.ts        # Barrel over the modules below
    ├── youtube-url.ts    # Video ids and watch URLs
    ├── youtube-video.ts  # Video metadata, chapters and comments
    ├── youtube-channel.ts # Channel and playlist listings and metadata
    ├── youtube-search.ts # Keyword search for videos and channels
    └── youtube-download.ts # Format listing and whole-video downloads
tests/                    # Unit, protocol-level and filesystem tests
└── e2e/                  # The built server against real yt-dlp (opt-in, see below)
scripts/smoke.mjs         # Post-build check that boots the server as a real client
```

## Scripts

| Command                 | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`                               |
| `npm run dev`           | Compile in watch mode                                       |
| `npm test`              | Run the test suite                                          |
| `npm run test:watch`    | Run tests in watch mode                                     |
| `npm run test:coverage` | Run tests and enforce coverage thresholds                   |
| `npm run test:e2e`      | Build, then drive the built server against real yt-dlp      |
| `npm run typecheck`     | Typecheck without emitting                                  |
| `npm run lint`          | Lint; warnings fail the build                               |
| `npm run format`        | Format with Prettier                                        |
| `npm run validate`      | Typecheck, lint, format check and test — run before pushing |

## Coding standards

- **TypeScript strict mode**, including `noUncheckedIndexedAccess`. Index access
  yields `T | undefined`; handle it rather than asserting it away.
- **No `any`**, and no `eslint-disable` without a written justification. The lint
  step fails on warnings, not just errors.
- **Explicit return types** on exported functions.
- **Never write to stdout.** In stdio mode it carries the JSON-RPC stream, so a
  stray `console.log` corrupts the protocol. Use `console.error` or the MCP
  logging capability.
- **Never spawn yt-dlp directly.** Route every call through `runYtDlp` in
  `src/utils/ytdlp.ts` so it inherits the timeout, concurrency limit, retry
  policy and cancellation handling.
- **Never surface raw yt-dlp stderr.** It routinely contains the full command
  line and local paths. Map failures to a `YouTubeError` with an actionable
  next step; add a new code in `src/utils/errors.ts` if none fits.
- **Validate before you fetch.** Anything checkable locally — a malformed
  timestamp, an inverted range, an output path outside the home directory —
  should fail immediately rather than after a network round trip.
- **Name tools verb first, and never prefix them with the service.**
  `search_videos`, `extract_clip`, `check_health` — an action the model is
  choosing to take, so it should read as one. Not `youtube_search_videos`: MCP
  clients already namespace tools by server, so a service prefix repeats what
  the client knows and spends tokens on it in every request. Not `health_check`
  either — that is a noun, not an action. Both rules are enforced by tests in
  `tests/protocol.test.ts`.

## Adding a tool

1. Pick the name first: **verb + what it acts on**, snake_case, no service
   prefix. Then create or extend a file in `src/tools/`, exporting three things:
   a Zod input schema, a Zod output schema, and the handler.

   ```ts
   export const myToolSchema = {
     video: z.string().describe('YouTube video ID or full URL'),
   };

   export const myToolOutputSchema = {
     videoId: z.string(),
     result: z.string(),
   };

   export async function myToolHandler({ video }: { video: string }): Promise<CallToolResult> {
     const data = await somethingUseful(video);
     return toolResult(renderForHumans(data), { videoId: video, result: data.value });
   }
   ```

   Every tool must return `structuredContent` on **every** path, including empty
   results and partial failures — the SDK validates it against the output schema.

2. Register it in `src/index.ts`, wrapping the handler in `guarded()` so it
   inherits error handling and the request context. Supply a title, a
   description that says precisely what it does, both schemas, and all four
   annotation hints.

3. Decide where it belongs. Tools that touch the filesystem go inside the
   `mode === 'stdio'` block; a remote deployment must not expose the host's disk.

4. Add tests, and update the manifest snapshot with `npx vitest run -u`. The
   snapshot diff is the review surface for public API changes.

5. Document it in the README tool table.

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add transcript summarization tool
fix: handle videos without captions
docs: update installation instructions
test: add coverage for the rate limiter
chore: update dependencies
refactor: simplify VTT parsing
```

Explain **why** in the body, not just what — the diff already says what.

## Pull requests

1. Fork and branch from `main`.
2. Make the change, with tests.
3. Run `npm run validate` — CI runs the same gate on Node 22 and 24.
4. Open a PR describing the problem and how you addressed it.

## Reporting bugs

Open an issue with the output of `check_health`, the tool and arguments you
called, what you expected, and what happened. If yt-dlp is involved, include its
version — YouTube changes frequently and many failures are fixed by `yt-dlp -U`.

Please do not report security issues in a public issue; see
[SECURITY.md](SECURITY.md).

## Running the end-to-end suite

The unit suite mocks every yt-dlp spawn. The end-to-end lane in `tests/e2e/`
drives the built server through real MCP clients, over stdio and HTTP, against
real yt-dlp and the real network, in an isolated temporary home. It is opt-in:

```bash
E2E=1 npm run test:e2e
E2E=1 E2E_DOCKER=1 npm run test:e2e -- tests/e2e/docker.e2e.ts
```

It needs `yt-dlp` and `ffmpeg` on PATH and a built `dist/`. `fixtures.e2e.ts`
runs first and re-verifies every public target the other specs rely on, so a
target that changed on YouTube fails by name. Nothing in the lane is retried,
and nothing is skipped without saying so.

YouTube refuses per-video data to addresses it distrusts, which is every
datacenter address: a VPN that exits in one, and every CI runner. The global
setup reads one video through the built server first; when YouTube answers with
its bot check, the four per-video spec files (transcripts, video reads, media,
brains) are skipped and the reason is printed, and in CI written to the job
summary. Everything listing-based still runs. To run the per-video specs from
such an address, set `YOUTUBE_MCP_COOKIES_FROM_BROWSER`, `YOUTUBE_MCP_COOKIES_FILE`
or `YOUTUBE_MCP_PROXY` in the shell that runs the lane; the harness passes them
through to the server under test. In CI the `E2E_COOKIES_FILE` secret, a
Netscape-format cookies export, does the same; the workflow writes it to an
owner-only file for the run.

CI runs the lane weekly, on every release before publishing, and on a pull
request that touches the Dockerfile's yt-dlp pin. yt-dlp there is installed
system-wide on purpose: a per-user pip install lives under the runner's home,
which the harness replaces.
