# Privacy Policy

Effective 2026-10-13. This policy covers the `youtube-knowledge-mcp` npm package and the
`youtube-knowledge` plugin built from this repository.

## Summary

The software runs entirely on your computer. The maintainer operates no server for it,
collects nothing from it, and receives no data from it.

## Data collection

None. The software contains no analytics, telemetry, crash reporting or update check. It
does not send any information about you, your prompts or your usage to the maintainer or
to any service the maintainer controls.

## What the software does with data

The server acts on requests Claude makes on your behalf. To answer them it contacts
third party services, always from your own computer and network address:

- **YouTube (Google).** yt-dlp requests YouTube for the videos, channels, playlists,
  captions, comments and searches you ask about. YouTube sees those requests as it would
  from any other client. Google's own privacy policy governs what it does with them.
- **YouTube image hosts** (`i.ytimg.com`, `yt3.googleusercontent.com`, `yt3.ggpht.com`).
  Thumbnails, avatars and banners are fetched over HTTPS from these hosts only.
- **YouTube media servers.** ffmpeg reads the media stream of a video when you ask for a
  clip, an audio clip, a frame or a download.
- **SponsorBlock** (`sponsor.ajay.app`). Only when you call `get_sponsor_segments`. The
  request carries the first four characters of a SHA-256 hash of the video id, never the
  id itself, as SponsorBlock's API is designed to be used. SponsorBlock's own policy
  governs that request.
- **The npm registry.** Claude Code downloads the packages pinned by the plugin's
  `package-lock.json` when the plugin is installed. npm's own policies govern that request.

Local transcription (`transcribe_video`) runs whisper.cpp on your computer. The audio
and the text it produces never leave it, and the model is a file you provide.

Content returned by these tools is passed to Claude as part of your conversation, and
Anthropic's privacy policy governs how Claude handles your conversations.

## Third party sharing

The maintainer shares nothing with third parties, because the maintainer holds nothing.
The services listed above receive only the requests described above.

## Storage and retention

Everything the software writes stays on your computer, under `~/.youtube-knowledge/` by
default, or under another folder inside your home directory when you pass one. That
covers cached transcripts, saved notes, channel brains, harvested catalogues and
comments, saved thumbnails, downloads, clips, frames and subtitle files. The caches,
library, brains, catalogue store and thumbnails are created readable by your user account
only (directories 0700, files 0600). Media files you ask for follow your umask.

- Cached transcripts expire after 30 days by default, and per video statistics after 1
  day. Both lifetimes can be changed with environment variables.
- Everything else stays until you delete it, using the `delete_*` and `prune_harvest`
  tools or by removing the folder. Uninstalling the plugin does not remove it.

## Cookies

Off by default. If you set `YOUTUBE_MCP_COOKIES_FROM_BROWSER` or `YOUTUBE_MCP_COOKIES_FILE`,
yt-dlp uses your signed in YouTube session, which can include personal content. The
server never logs the cookie file path or contents and never returns them in tool output.
yt-dlp uses the session for its requests to YouTube, as a browser signed in to your
account would.

## Contact

Questions about this policy: open an issue at
https://github.com/teobouancheau/youtube-knowledge-mcp/issues. Security reports: use
[private vulnerability reporting](https://github.com/teobouancheau/youtube-knowledge-mcp/security/advisories/new).

## Changes

Changes to this policy are made in this repository, and the history is public.
