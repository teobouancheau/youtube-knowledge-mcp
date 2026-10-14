# YouTube Knowledge

Gives Claude tools to search YouTube, read timestamped transcripts, comments and
metadata, cut clips and capture frames, and keep what it learns in a searchable local
library and in per channel "brains" built from everything a creator has said.

The server runs on your computer. Nothing is hosted, and no account or API key is needed.

## Where it runs

This plugin declares a local MCP server, so it works in Claude Code and in Cowork
sessions that run on your computer. It does not run in claude.ai chat on the web or on
mobile.

## Requirements

- Node.js 22.13 or newer
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on your PATH, required by every tool
- [ffmpeg](https://ffmpeg.org/) on your PATH, required only for downloads, clips, audio
  clips and frame capture

yt-dlp and ffmpeg are not bundled with this plugin. After installing, ask Claude to run
`check_health` to confirm both are present and current. An outdated yt-dlp is the most
common cause of failures, because YouTube changes often; `yt-dlp -U` fixes most of them.

## What the plugin runs

The server is declared in `.mcp.json` as `npx -y youtube-knowledge-mcp@<exact version>`.
On first use, npx downloads that exact version of the published
[npm package](https://www.npmjs.com/package/youtube-knowledge-mcp) and its dependencies
from the npm registry. The package then starts over stdio and spawns `yt-dlp` and
`ffmpeg` from your PATH. The plugin ships no scripts, hooks or binaries of its own. The
full source is in the [repository](https://github.com/teobouancheau/youtube-knowledge-mcp).

## What it sends and fetches

- **YouTube, through yt-dlp.** For every video, channel, playlist or search you ask
  about, yt-dlp requests YouTube from your own network address.
- **Image hosts, over HTTPS only.** Thumbnails, avatars and banners are fetched from
  `i.ytimg.com`, `yt3.googleusercontent.com` and `yt3.ggpht.com`, and from nowhere else.
  This is the only HTTP request the server makes itself.
- **YouTube media, through ffmpeg.** For clips, audio clips, frames and downloads,
  yt-dlp resolves the media URL and ffmpeg reads it over HTTPS.
- **The npm registry**, once, to install the package.

There is no analytics, no telemetry and no other destination. The author receives no data.

## What it stores

Everything is written under `~/.youtube-knowledge/` in your home directory: cached
transcripts (30 days by default), saved notes, channel brains, harvested catalogues and
comments, saved thumbnails, and any downloads, clips, frames or subtitle files you ask
for. Tools refuse to write outside your home directory. Delete anything with the
matching `delete_*` tool, or remove the folder.

## Optional settings

The plugin sets none of these. If you export them yourself before starting Claude, they
apply: `YOUTUBE_MCP_COOKIES_FROM_BROWSER` or `YOUTUBE_MCP_COOKIES_FILE` lets yt-dlp use
your signed in YouTube session for age restricted or members only videos, and
`YOUTUBE_MCP_PROXY` routes yt-dlp through a proxy. Cookies are your account, so leave
them unset unless you need them. See the
[full configuration reference](https://github.com/teobouancheau/youtube-knowledge-mcp#environment-variables).

## Privacy and license

See the [privacy policy](https://github.com/teobouancheau/youtube-knowledge-mcp/blob/main/PRIVACY.md).
Released under the MIT license.
