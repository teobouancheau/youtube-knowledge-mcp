# YouTube Knowledge MCP

[![npm version](https://img.shields.io/npm/v/youtube-knowledge-mcp.svg)](https://www.npmjs.com/package/youtube-knowledge-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/teobouancheau/youtube-knowledge-mcp?style=social)](https://github.com/teobouancheau/youtube-knowledge-mcp)

A Model Context Protocol (MCP) server that gives AI assistants the ability to search, analyze, and extract knowledge from YouTube videos. Works with Claude Desktop, Claude Code, Claude.ai, Cursor and any MCP-compatible client.

Supports both **local** (stdio) and **remote** (Streamable HTTP) transports.

![YouTube Knowledge MCP](https://raw.githubusercontent.com/teobouancheau/youtube-knowledge-mcp/main/thumbnail.png)

## Features

**Find and read**

- **Search** videos and channels by keyword
- **Fetch** videos from a playlist or channel
- **Video, channel and playlist metadata**, chapters, and top comments
- **Thumbnails**: look at any video's thumbnail or a channel's avatar or banner as an image, or save every thumbnail of a channel to disk
- **Transcripts with timestamps**, sliced by time range or chapter, and capped so a
  three-hour video cannot flood your context
- **Search inside a transcript** and get back `?t=` links that open the video at
  the exact moment
- **Batch tools**: transcripts for many videos at once, or a whole-playlist digest

**Extract for editing**

- **Clip a time range** without downloading the whole video, cut precisely or on
  keyframes, by timestamp or chapter name
- **Audio clips** in mp3, m4a, wav, flac or opus
- **Frame capture** at any timestamp, without downloading the file
- **Subtitle export** as SRT, WebVTT or plain text for Premiere, Resolve or CapCut
- **Full downloads** with quality presets

**Keep what you learn** (local mode)

- **Save** summaries and skill notes to a local library
- **Read them back**, and **search across all of them** with full-text ranking
- **Tag, retag and delete**

**Build a brain for a channel** (local mode)

- **Read a whole channel** into a searchable corpus of timestamped passages, in
  any caption language, resumable and safe to interrupt — a second run continues
  where it stopped and picks up new uploads
- **Ask what a creator has said** about anything, across every video, and get
  back the moments themselves with links that open the video there
- **Measure the channel**: how much was readable, its upload rhythm, its
  speaking rate, and the phrases it repeats across videos
- **Keep a written profile** beside the corpus, grounded in passages you can cite

**Study a channel's thumbnails** (local mode)

- **Save every thumbnail** of a channel, plus its avatar and banner, resumably, at the largest size YouTube serves, with each image's real pixel size recorded

**Built to stay working**

- WebVTT parsed by the W3C reference implementation, not a hand-written matcher
- Typed, actionable errors — "no captions in en, try: fr, es, de" rather than a
  wall of yt-dlp stderr
- Timeouts, retry with backoff, and a concurrency limit on every yt-dlp call
- `check_health` diagnoses missing or outdated yt-dlp and ffmpeg
- Bearer auth, a loopback default bind, an allowlist on every URL and image host, and typed error codes on every failure
- Structured output on every tool, plus MCP resources, prompts and completions

## Prerequisites

- Node.js 22+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) — required by every tool.
  `brew install yt-dlp` (macOS) or `pip install -U yt-dlp`
- [ffmpeg](https://ffmpeg.org/) — required for downloads, clip extraction and frame
  capture. Everything else works without it.

Run the `check_health` tool to confirm both are installed and current. An
outdated yt-dlp is the most common cause of unexplained failures, since YouTube
changes frequently; `yt-dlp -U` fixes most of them.

## Installation

### Via npm (Recommended)

```bash
npm install -g youtube-knowledge-mcp
```

### Via npx (no installation)

Configure directly with npx (see Configuration section).

### From source

```bash
git clone https://github.com/teobouancheau/youtube-knowledge-mcp.git
cd youtube-knowledge-mcp
npm install
npm run build
```

## Configuration

### Local (stdio) -- Claude Desktop, Claude Code, Cursor

#### Quick Start with npx

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "npx",
      "args": ["-y", "youtube-knowledge-mcp"]
    }
  }
}
```

#### With Global Installation

```bash
npm install -g youtube-knowledge-mcp
```

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "youtube-knowledge-mcp"
    }
  }
}
```

#### Configuration File Locations

| Client                       | Path                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| **Claude Desktop (macOS)**   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop (Windows)** | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| **Claude Desktop (Linux)**   | `~/.config/Claude/claude_desktop_config.json`                     |
| **Claude Code**              | `.mcp.json` in your project or `~/.claude/settings.json`          |
| **Cursor**                   | `.cursor/mcp.json` in your project                                |

Restart your client after updating configuration.

### Remote (HTTP) -- Claude.ai, Claude Mobile, Custom Connectors

The server supports Streamable HTTP transport for remote access via Claude's official connectors.

**Every remote setup is your own deployment.** There is no shared instance to
point a connector at, by design: every call shells out to yt-dlp, so a single
host serving other people's traffic is a host YouTube rate-limits for all of
them. The button below deploys this repository into your own Render account, in
about two minutes and without cloning anything.

#### Self-hosted

```bash
npm run build
npm run start:http
```

The server listens on `127.0.0.1:PORT` (default 3000). To reach it from another
machine set `MCP_BIND_HOST=0.0.0.0` together with `MCP_AUTH_TOKEN`; the server
refuses to start exposed and unauthenticated unless you also set
`MCP_ALLOW_UNAUTHENTICATED=true`. Behind a reverse proxy, set `MCP_TRUST_PROXY`
to the number of hops and `MCP_PUBLIC_URL` to the address clients use.

#### Docker

```bash
docker build -t youtube-knowledge-mcp .

TOKEN=$(openssl rand -hex 32) && echo "MCP_AUTH_TOKEN=$TOKEN"
docker run -p 3000:10000 -e MCP_AUTH_TOKEN="$TOKEN" youtube-knowledge-mcp
```

The token is printed because nothing else will print it: the server logs that a
token is required, never its value. Send it as `Authorization: Bearer $TOKEN`.

The image sets `PORT=10000` and exposes it; publish it on whatever host port you
like. The build happens inside the image, so no local `npm run build` first.

#### Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/teobouancheau/youtube-knowledge-mcp)

The button opens Render's Blueprint flow against [`render.yaml`](render.yaml) in
this repository, which builds the Docker image, points the health check at
`/health` and generates an `MCP_AUTH_TOKEN` for you. No fork, no clone, no
settings to fill in — the service is yours, on your account.

1. Click the button and confirm. Render builds the image and deploys it.
2. Open the service's **Environment** tab and copy the generated
   `MCP_AUTH_TOKEN`. The HTTP transport rejects every request without it, so a
   URL that leaks is not an open server.
3. Add `https://<your-service>.onrender.com/mcp` as a custom connector, with
   `Authorization: Bearer <token>`.

Worth doing once the service exists: set `MCP_ALLOWED_HOSTS` to your service's
hostname (`<your-service>.onrender.com`). It cannot be filled in from the
Blueprint, since the hostname does not exist until the service does, and it
rejects requests arriving under any other name.

Your instance does not follow this repository. The Blueprint sets
`autoDeployTrigger: off`, because auto-deploying would run code pushed here
inside your account, under your token, without you reading it first. To take a
newer version, use **Manual Deploy** on the service.

The free plan sleeps after inactivity, so the first call after a pause waits for
a cold start. Any paid plan removes that.

#### Connect via Claude.ai

1. Go to **Settings > Connectors**
2. Click **Add custom connector**
3. Enter your server URL (e.g., `https://your-app.onrender.com/mcp`)
4. Add the `Authorization: Bearer <token>` header if you set `MCP_AUTH_TOKEN`
5. Click **Add**

## MCP Tools

37 tools. The 15 read-only ones work over both transports; the 22 that touch
your filesystem are registered only in local (stdio) mode, so a remote
deployment cannot reach the host's disk.

Every tool returns human-readable text **and** typed structured output, and
reports failures as an actionable message — `[NO_CAPTIONS] No "en" captions are
available for this video. Call get_transcript again with one of: fr, es, de.`

### Discovery — remote + local

| Tool                | Key parameters                         | Returns                                                                                   |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `search_videos`     | `query`, `limit`                       | Matching videos with durations, channels and view counts                                  |
| `search_channels`   | `query`, `limit`                       | Matching channels with subscriber counts                                                  |
| `fetch_videos`      | `url`, `limit`                         | Videos in a playlist or channel, with thumbnail URLs                                      |
| `get_video_info`    | `video`                                | Title, channel, duration, views, likes, description, tags                                 |
| `get_channel_info`  | `channel`                              | Name, handle, subscriber count, description, avatar and banner                            |
| `get_playlist_info` | `url`                                  | Title, channel, video count, last updated                                                 |
| `get_chapters`      | `video`                                | Chapter titles with start/end times and deep links                                        |
| `get_comments`      | `video`, `limit`                       | Top-level comments by popularity                                                          |
| `list_formats`      | `video`                                | Available formats grouped by video+audio, video-only, audio-only                          |
| `get_thumbnail`     | `video`, `channel`, `image`, `quality` | A video thumbnail, channel avatar or banner as an image, with its real size               |
| `check_health`      | —                                      | yt-dlp and ffmpeg status, versions, staleness warnings, and which session options are set |

### Transcripts — remote + local

| Tool                | Key parameters                                                                                   | Returns                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `get_transcript`    | `video`, `language`, `format`, `startTime`/`endTime`, `chapter`, `maxChars`, `offset`, `refresh` | Transcript as plain text, timestamped lines, or cues     |
| `search_transcript` | `video`, `query`, `regex`, `caseSensitive`, `limit`, `contextSeconds`                            | Matches with timestamps and `?t=` deep links             |
| `get_transcripts`   | `videos` (up to 25), `language`, `maxCharsPerVideo`                                              | Transcripts for many videos; failures reported per video |
| `digest_playlist`   | `url`, `limit`, `includeChapters`, `includeTranscriptStats`                                      | Per-video metadata, chapters and transcript stats        |

`format: "timestamped"` prefixes each line with `[MM:SS]` — use it when you need
to cite or link to a moment. `maxChars` with `offset` reads a long transcript in
pieces instead of returning 100,000+ tokens at once.

### Extraction for editing — local only

| Tool                 | Key parameters                                                             | Returns                      |
| -------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `extract_clip`       | `video`, `start`+`end` or `chapter`, `quality`, `preciseCuts`, `outputDir` | Path to the cut video        |
| `extract_audio_clip` | `video`, `start`+`end` or `chapter`, `audioFormat`, `outputDir`            | Path to the audio file       |
| `extract_clips`      | `video`, `ranges` (up to 20), `quality`, `preciseCuts`, `outputDir`        | One file per range           |
| `extract_frame`      | `video`, `timestamp`, `format`, `outputDir`                                | Path to a PNG or JPG still   |
| `export_subtitles`   | `video`, `format` (srt/vtt/txt), `language`, `outputDir`                   | Path to the subtitle file    |
| `download_video`     | `video`, `quality`, `formatId`, `outputDir`                                | Path to the downloaded video |

Clips are cut with `--download-sections`, so only the byte range covering the
window is fetched rather than the whole file. `preciseCuts` (default `true`)
cuts exactly at the requested times; set it to `false` for a faster
keyframe-aligned cut. All of these require ffmpeg.

### Knowledge library — local only

| Tool                    | Key parameters                                                  | Returns                             |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `save_to_library`       | `videoId`, `title`, `content`, `contentType`, `channel`, `tags` | Path to the saved note              |
| `list_library`          | `tag`                                                           | Saved items, newest first           |
| `get_library_item`      | `videoId`, `contentType`                                        | The saved markdown and its metadata |
| `search_library`        | `query`, `limit`, `offset`                                      | Ranked matches with excerpts        |
| `update_library_tags`   | `videoId`, `add`, `remove`, `replace`                           | The updated tags                    |
| `delete_library_item`   | `videoId`, `contentType`                                        | What was deleted                    |
| `rebuild_library_index` | —                                                               | Number of notes reindexed           |

### Channel brains — local only

| Tool                 | Key parameters                                                    | Returns                                          |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `build_brain`        | `channel`, `maxVideos`, `language`, `since`, `minDurationSeconds` | What was read, what was ruled out, and the stats |
| `ask_brain`          | `channel`, `query`, `limit`, `offset`                             | Passages with timestamps and `?t=` links         |
| `list_brains`        | —                                                                 | Every brain built locally                        |
| `get_brain_info`     | `channel`, `includeVideos`                                        | Coverage, statistics and repeated phrases        |
| `save_brain_profile` | `channel`, `content`                                              | Path to the saved profile                        |
| `delete_brain`       | `channel`                                                         | What was removed                                 |

`build_brain` is the only one that touches the network. The rest resolve a
channel from what is already on disk, so they work offline and cost nothing to
call.

### Channel thumbnails — local only

| Tool                        | Key parameters                               | Returns                                                   |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `fetch_channel_thumbnails`  | `channel`, `maxVideos`, `tabs`, `quality`    | Every thumbnail saved to disk, plus the avatar and banner |
| `list_channel_thumbnails`   | `channel`, `tab`, `state`, `limit`, `offset` | Saved entries with paths and decoded sizes                |
| `delete_channel_thumbnails` | `channel`                                    | What was removed                                          |

One yt-dlp listing per tab, then the images from YouTube's image hosts
directly, so a five-hundred-video channel costs a handful of listings and not
five hundred extractions. For each video the fetch tries the largest image
YouTube serves (`maxresdefault`, 1280 wide where it exists) and keeps it only if
it decodes wider than the image the listing offered; otherwise it keeps the
listed image, and failing that the small `hqdefault`. Every width and height in
the manifest was decoded from the saved bytes, never read off a URL. Shorts are
listed with portrait thumbnails and saved under `shorts/`. The run is resumable:
interrupt it and call again, and only what is missing or truncated is fetched.

A brain holds one caption language; pass `language` to read another, and build a
separate brain per language.

`since` and `minDurationSeconds` describe the brain, not just the call that
passed them. They are re-applied every time, so narrowing one drops the passages
of the videos it excludes and widening it reads them back — which is why
`build_brain` is annotated as destructive. Whether a video qualifies is decided
from the date and length already recorded, so changing your mind costs no
requests until there is something new to fetch. Those values come from each
video's own metadata, never from a guess: a flat channel listing does not carry
a publication date at all.

`build_brain` also repairs. If the passage file is lost or truncated, the videos
it can no longer account for are read again on the next call rather than being
skipped forever as already done.

## Prompts

Reusable workflows your client can invoke directly: `summarize_video`,
`extract_skill`, `compare_videos`, `research_topic`, `channel_deep_dive`,
`clip_from_quote` (find a phrase, then cut the clip around it),
`study_thumbnails` (save a channel's thumbnails, look at a sample, describe
what recurs), and — local only — `review_library`, `create_brain` (build a
channel's corpus, then write its profile from it) and `ask_creator` (answer a
question strictly from a brain, with citations).

## Resources

- `youtube://transcript/{videoId}` — a timestamped transcript, fetched and cached on first read
- `youtube://library/{videoId}/{summary|skill}` — a saved note (local only, and enumerable)
- `youtube://brain/{channelId}/{manifest|profile}` — what a channel brain covers, or the profile written from it (local only, and enumerable)
- `youtube://thumbnails/{channelId}/manifest` — what `fetch_channel_thumbnails` saved for a channel (local only, and enumerable)

## Error codes

Failures are reported inside the result so the model can read and recover from
them, each prefixed with a code and followed by a next step.

| Code                                                                | Meaning                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PRIVATE`, `AGE_GATED`, `MEMBERS_ONLY`, `PREMIUM_ONLY`, `NOT_FOUND` | The video cannot be accessed                                                 |
| `LOGIN_REQUIRED`                                                    | yt-dlp reports the video needs a signed-in account                           |
| `NO_CAPTIONS`                                                       | No captions in the requested language; the message lists the ones that exist |
| `LIVE_NOT_ENDED`                                                    | An upcoming stream, or one whose recording is still processing               |
| `RATE_LIMITED`, `TIMEOUT`                                           | Transient; retried automatically with backoff before surfacing               |
| `YTDLP_MISSING`, `FFMPEG_MISSING`, `YTDLP_FAILED`                   | A tooling problem; the message says how to fix it                            |
| `INVALID_INPUT`                                                     | A bad argument, caught before any network call                               |
| `BOT_CHECK`                                                         | YouTube asked this address to sign in; set the cookie settings below         |
| `FETCH_FAILED`                                                      | An image could not be downloaded from YouTube's image hosts                  |
| `CANCELLED`                                                         | The client cancelled the request                                             |

## Environment variables

All optional.

| Variable                           | Default     | Purpose                                                                                                                                                      |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_AUTH_TOKEN`                   | unset       | Require this bearer token on the HTTP transport. **Set this if you expose the server beyond localhost.**                                                     |
| `MCP_ALLOWED_HOSTS`                | unset       | Comma-separated Host allowlist; enables DNS-rebinding protection                                                                                             |
| `MCP_ALLOWED_ORIGINS`              | unset       | Comma-separated Origin allowlist                                                                                                                             |
| `MCP_BIND_HOST`                    | `127.0.0.1` | Interface to bind. The Docker image sets `0.0.0.0`. A non-loopback bind refuses to start without `MCP_AUTH_TOKEN` unless `MCP_ALLOW_UNAUTHENTICATED=true`    |
| `MCP_ALLOW_UNAUTHENTICATED`        | `false`     | Explicit consent to listen on a network interface with no token                                                                                              |
| `MCP_TRUST_PROXY`                  | `false`     | `true`, `false`, or the number of reverse-proxy hops whose `X-Forwarded-*` headers to believe. Off, forwarded headers are ignored for rate limiting and URLs |
| `MCP_PUBLIC_URL`                   | unset       | The URL clients reach the server at; used in the OAuth metadata it publishes instead of the request's Host                                                   |
| `MCP_MAX_BODY_BYTES`               | `1048576`   | Largest request body accepted                                                                                                                                |
| `MCP_MODE`                         | unset       | `http` selects the HTTP transport when no `--http` flag is given                                                                                             |
| `PORT`                             | `3000`      | HTTP port. The Docker image sets `10000`; Render and similar platforms inject their own                                                                      |
| `MCP_RATE_LIMIT`                   | `60`        | Requests per window, per client                                                                                                                              |
| `MCP_RATE_WINDOW_MS`               | `60000`     | Rate-limit window                                                                                                                                            |
| `MCP_SESSION_IDLE_MS`              | `1800000`   | Close HTTP sessions idle this long                                                                                                                           |
| `MCP_MAX_SESSIONS`                 | `1000`      | Reject new sessions past this many                                                                                                                           |
| `YOUTUBE_MCP_MAX_CONCURRENCY`      | `3`         | Concurrent yt-dlp processes                                                                                                                                  |
| `YOUTUBE_MCP_TRANSCRIPT_TTL_MS`    | 30 days     | Transcript cache lifetime                                                                                                                                    |
| `YOUTUBE_MCP_COOKIES_FROM_BROWSER` | unset       | Browser whose cookies yt-dlp should read: `brave`, `chrome`, `chromium`, `edge`, `firefox`, `opera`, `safari`, `vivaldi` or `whale`. See Signed-in content   |
| `YOUTUBE_MCP_COOKIES_FILE`         | unset       | A Netscape-format cookies file inside your home directory, as an alternative to a browser                                                                    |
| `YOUTUBE_MCP_PROXY`                | unset       | An `http`, `https`, `socks4` or `socks5` proxy URL for yt-dlp                                                                                                |
| `YOUTUBE_MCP_SLEEP_REQUESTS_S`     | unset       | Seconds yt-dlp sleeps between its own requests, to stay under YouTube's limits                                                                               |

### Signed-in content

Some videos need a signed-in session — age-restricted, members-only, private
ones you have access to — and YouTube sometimes asks an address to prove it is
not a bot before serving any video at all. Those failures arrive as
`LOGIN_REQUIRED`, `AGE_GATED` or `BOT_CHECK`, and each names the fix: set
`YOUTUBE_MCP_COOKIES_FROM_BROWSER` to a browser you are signed in with, or
`YOUTUBE_MCP_COOKIES_FILE` to a cookies file, and restart the server.

Cookies are your account. Use them in local (stdio) mode, keep a cookies file
readable by you alone, and know that content read this way may be personal.
The server validates both settings at boot, never logs the file's path or
contents, and never surfaces yt-dlp's output.

## Library Storage

Content is stored in `~/.youtube-knowledge/`:

```
~/.youtube-knowledge/
├── transcripts/          # Cached timestamped transcripts
│   └── {video_id}.{lang}.json
├── library/              # Saved notes
│   └── {video_id}/
│       ├── metadata.json
│       ├── summary.md
│       └── skill.md
├── brains/               # Channel brains
│   └── {channel_id}/
│       ├── manifest.json # What the brain covers, and where a build stopped
│       ├── chunks.json   # The timestamped passages
│       └── profile.md    # The written account, if one was saved
├── thumbnails/           # Saved channel thumbnails
│   └── {channel_id}/
│       ├── manifest.json # Every image, its decoded size, where it is
│       ├── channel/      # avatar.* and banner.*
│       ├── videos/       # {video_id}.jpg (or .png / .webp)
│       ├── shorts/
│       └── streams/
├── downloads/            # Full downloads
├── clips/                # Extracted clips
├── frames/               # Captured stills
├── subtitles/            # Exported SRT / VTT / TXT
├── index.json            # Library index
└── search-index.json     # Full-text search index
```

Transcripts are cached for 30 days by default; pass `refresh: true` to any
transcript tool to bypass the cache, or set `YOUTUBE_MCP_TRANSCRIPT_TTL_MS`.

Every tool that writes files confines its output to your home directory, and
`outputDir` is rejected if it points anywhere else.

## Usage Examples

### Find a moment and cite it

```
"Find where this video talks about rate limiting and give me the timestamp:
 https://youtube.com/watch?v=..."
```

`search_transcript` returns each match with a link that opens the video at that
second, so the claim can be checked rather than taken on trust.

### Find a moment and clip it

```
"Find where she says 'the real bottleneck was the database' and cut me a
 30-second clip around it"
```

`search_transcript` locates the moment, `extract_clip` cuts it. Only the byte
range covering the clip is downloaded.

### Read one section of a long video

```
"Summarize just the 'Benchmarks' chapter of this 3-hour podcast"
```

`get_chapters` finds the section, then `get_transcript` with `chapter:
"Benchmarks"` reads only that part instead of the whole thing.

### Survey a playlist cheaply

```
"What does this 40-video course cover, and which three videos should I watch?"
```

`digest_playlist` returns metadata and chapters for every video in one call.

### Prepare footage for an edit

```
"Pull these four moments as separate clips and export the subtitles as SRT"
```

`extract_clips` cuts all four in one call; `export_subtitles` writes a file your
editor can import.

### Build and query a knowledge base

```
"Summarize this video and save it to my library tagged 'databases'"
"What have I saved about connection pooling?"
```

`save_to_library` stores it; `search_library` searches across everything saved
with full-text ranking.

### Build a brain for a creator

```
"Build a brain for @Fireship, then tell me everything they've said about Rust"
```

`build_brain` reads the channel into timestamped passages — interrupt it and
call it again to continue. `ask_brain` then answers from what was actually
said, returning the moments themselves so every claim can be checked against
the video. Run `build_brain` again a month later and it reads only the new
uploads.

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report, with thresholds enforced
```

The suite covers the pure logic directly, drives the real server through an MCP
client over an in-memory transport, exercises the library against a real
temporary filesystem, and snapshots the tool manifest so any change to the
public surface shows up as a reviewable diff.

## Development

```bash
npm run dev        # Watch mode
npm run build      # Build for production
npm run rebuild    # Clean and rebuild
npm start          # Run server (stdio)
npm run start:http # Run server (HTTP)
npm run validate   # Typecheck + lint + format check + test
```

CI runs the same gate on Node 22 and 24 for every push and pull request,
then boots the built server as a real MCP client to verify the manifest.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
project layout, coding standards, and how to add a tool.

## Security

The HTTP transport binds loopback and refuses to listen on a network interface
without `MCP_AUTH_TOKEN`. Caller-supplied URLs must be on a YouTube host before
anything is handed to yt-dlp, every yt-dlp target follows a `--` terminator, and
ids are validated before they become paths. See [SECURITY.md](SECURITY.md) for
the deployment checklist and how to report a vulnerability.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube extraction
- [Anthropic](https://anthropic.com) for the Model Context Protocol

---

<div align="center">
  <strong>Built by <a href="https://github.com/teobouancheau">teobouancheau</a></strong>
  <br>
  <sub>AI + YouTube knowledge to supercharge content creation</sub>
</div>
