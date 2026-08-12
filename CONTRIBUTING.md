# Contributing

Thanks for your interest in improving youtube-knowledge-mcp.

## Setup

```bash
git clone https://github.com/teobouancheau/youtube-knowledge-mcp.git
cd youtube-knowledge-mcp
npm install
npm run build
```

You also need [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`, and
[ffmpeg](https://ffmpeg.org/) for downloads, clip extraction and frame capture.
Run the `health_check` tool at any time to confirm both are present and current
— an outdated yt-dlp is the most common cause of unexplained failures.

## Project structure

```
src/
├── index.ts              # Server construction, tool registration, stdio entry point
├── http.ts               # Streamable HTTP transport: auth, sessions, rate limits
├── prompts.ts            # Reusable workflow prompts
├── resources.ts          # Transcript and library resources
├── schemas.ts            # Shared Zod output schemas
├── tools/                # One file per tool group: input schema, output schema, handler
└── utils/
    ├── ytdlp.ts          # The only place yt-dlp is spawned
    ├── errors.ts         # Typed failure codes and stderr classification
    ├── preflight.ts      # yt-dlp / ffmpeg presence and staleness checks
    ├── context.ts        # Per-request abort signal, progress and logging
    ├── transcript.ts     # WebVTT parsing, slicing, search, subtitle export
    ├── clips.ts          # Clip, audio and frame extraction
    ├── search-index.ts   # BM25 index for the local library
    ├── storage.ts        # Library persistence
    ├── validate.ts       # Path, language and timestamp validation
    └── format.ts         # Result construction and human-readable formatting
tests/                    # Unit, protocol-level and filesystem tests
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

## Adding a tool

1. Create or extend a file in `src/tools/`, exporting three things: a Zod input
   schema, a Zod output schema, and the handler.

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
3. Run `npm run validate` — CI runs the same gate on Node 20, 22 and 24.
4. Open a PR describing the problem and how you addressed it.

## Reporting bugs

Open an issue with the output of `health_check`, the tool and arguments you
called, what you expected, and what happened. If yt-dlp is involved, include its
version — YouTube changes frequently and many failures are fixed by `yt-dlp -U`.

Please do not report security issues in a public issue; see
[SECURITY.md](SECURITY.md).
