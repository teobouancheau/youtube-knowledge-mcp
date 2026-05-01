# YouTube Knowledge MCP

[![npm version](https://img.shields.io/npm/v/youtube-knowledge-mcp.svg)](https://www.npmjs.com/package/youtube-knowledge-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/teobouancheau/youtube-knowledge-mcp?style=social)](https://github.com/teobouancheau/youtube-knowledge-mcp)

A Model Context Protocol (MCP) server that gives AI assistants the ability to search, analyze, and extract knowledge from YouTube videos. Works with Claude Desktop, Claude Code, Claude.ai, Cursor and any MCP-compatible client.

Supports both **local** (stdio) and **remote** (Streamable HTTP) transports.

![YouTube Knowledge MCP](https://raw.githubusercontent.com/teobouancheau/youtube-knowledge-mcp/main/thumbnail.png)

## Features

- **Search videos** by keyword or phrase
- **Fetch videos** from playlists or channels
- **Get video info** (title, channel, duration, views, likes, comments, description, tags)
- **Extract transcripts** (auto-generated or manual captions)
- **Get chapters** (timestamps and structure)
- **Get comments** (top comments sorted by popularity)
- **Get channel info** (name, handle, subscriber count, description)
- **List formats** (available download resolutions and codecs)
- **Download videos** with quality selection (local mode only)
- **Save to library** (summaries, notes, skills) (local mode only)
- **List library** with tag filtering (local mode only)

## Prerequisites

- Node.js 20+
- yt-dlp: `brew install yt-dlp` (macOS) or [see installation guide](https://github.com/yt-dlp/yt-dlp#installation)

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

#### Self-hosted

```bash
npm run build
npm run start:http
```

The server listens on `PORT` (default 3000). Set `PORT` environment variable to change.

#### Docker

```bash
npm run build
docker build -t youtube-knowledge-mcp .
docker run -p 3000:10000 youtube-knowledge-mcp
```

#### Deploy to Render

1. Push to GitHub
2. Create a **Web Service** on Render with **Docker** runtime
3. Render sets `PORT` automatically
4. Add the Render URL as a custom connector in Claude.ai > Settings > Connectors

#### Connect via Claude.ai

1. Go to **Settings > Connectors**
2. Click **Add custom connector**
3. Enter your server URL (e.g., `https://your-app.onrender.com/mcp`)
4. Click **Add**

## MCP Tools

### Remote + Local (10 tools)

#### search_videos

Search YouTube for videos by keyword or phrase.

| Parameter | Type   | Default  | Description                      |
| --------- | ------ | -------- | -------------------------------- |
| `query`   | string | required | Search query                     |
| `limit`   | number | 5        | Maximum results to return (1-20) |

**Returns:** video IDs, titles, durations, channels, view counts, URLs

#### fetch_videos

List videos from a YouTube playlist or channel.

| Parameter | Type   | Default  | Description                          |
| --------- | ------ | -------- | ------------------------------------ |
| `url`     | string | required | Playlist URL, channel URL, or handle |
| `limit`   | number | 20       | Maximum videos to return (1-100)     |

#### get_video_info

Get detailed metadata for a single YouTube video.

| Parameter | Type   | Description     |
| --------- | ------ | --------------- |
| `video`   | string | Video ID or URL |

**Returns:** title, channel, duration, upload date, view count, like count, comment count, description, tags, thumbnail URL

#### get_transcript

Extract the full transcript from a YouTube video.

| Parameter  | Type   | Default  | Description                    |
| ---------- | ------ | -------- | ------------------------------ |
| `video`    | string | required | Video ID or URL                |
| `language` | string | "en"     | Preferred language (ISO 639-1) |

**Returns:** plain text transcript with word count and detected language

#### get_chapters

Extract chapter markers and timestamps from a YouTube video.

| Parameter | Type   | Description     |
| --------- | ------ | --------------- |
| `video`   | string | Video ID or URL |

**Returns:** chapter titles with start and end times. Empty list if no chapters found.

#### get_comments

Get top comments from a YouTube video sorted by popularity.

| Parameter | Type   | Default  | Description                                 |
| --------- | ------ | -------- | ------------------------------------------- |
| `video`   | string | required | Video ID or URL                             |
| `limit`   | number | 20       | Maximum top-level comments to return (1-50) |

**Returns:** author, text, like count, pinned status

#### get_channel_info

Get metadata for a YouTube channel.

| Parameter | Type   | Description                                    |
| --------- | ------ | ---------------------------------------------- |
| `channel` | string | Channel URL, handle (e.g., @Fireship), or name |

**Returns:** channel name, handle, subscriber count, description, channel URL

#### search_channels

Search YouTube for channels by keyword or phrase.

| Parameter | Type   | Default  | Description                       |
| --------- | ------ | -------- | --------------------------------- |
| `query`   | string | required | Search query for channels         |
| `limit`   | number | 5        | Maximum channels to return (1-20) |

**Returns:** channel names, handles, subscriber counts, descriptions, URLs

#### get_playlist_info

Get metadata for a YouTube playlist.

| Parameter | Type   | Description          |
| --------- | ------ | -------------------- |
| `url`     | string | YouTube playlist URL |

**Returns:** title, channel, video count, last updated date, description

#### list_formats

List all available download formats for a YouTube video.

| Parameter | Type   | Description     |
| --------- | ------ | --------------- |
| `video`   | string | Video ID or URL |

**Returns:** format IDs, extensions, resolutions, FPS, codecs, file sizes

### Local Only (3 tools, stdio mode)

These tools operate on the local filesystem and are only available in stdio mode.

#### download_video

Download a YouTube video to local disk.

| Parameter   | Type   | Default  | Description                                                         |
| ----------- | ------ | -------- | ------------------------------------------------------------------- |
| `video`     | string | required | Video ID or URL                                                     |
| `quality`   | string | "best"   | Quality preset (best, 2160p, 1440p, 1080p, 720p, 480p, 360p, audio) |
| `formatId`  | string | -        | Specific format code from list_formats                              |
| `outputDir` | string | -        | Custom output directory                                             |

#### save_to_library

Save a summary or skill note to your local YouTube knowledge library.

| Parameter      | Type     | Description                        |
| -------------- | -------- | ---------------------------------- |
| `video_id`     | string   | YouTube video ID                   |
| `title`        | string   | Video title                        |
| `content`      | string   | Content to save (markdown format)  |
| `content_type` | string   | "summary" or "skill"               |
| `tags`         | string[] | Tags for categorization (optional) |
| `channel`      | string   | Channel name (optional)            |

#### list_library

List all saved items in your local knowledge library.

| Parameter | Type   | Description                             |
| --------- | ------ | --------------------------------------- |
| `tag`     | string | Filter by tag (optional, partial match) |

## Library Storage

Content is stored in `~/.youtube-knowledge/`:

```
~/.youtube-knowledge/
├── transcripts/          # Cached transcripts
│   └── {video_id}.txt
├── library/              # Saved content
│   └── {video_id}/
│       ├── metadata.json
│       ├── summary.md
│       └── skill.md
├── downloads/            # Downloaded videos
│   └── {video_title}.{ext}
└── index.json            # Searchable index
```

## Usage Examples

### Search and analyze

```
"Search YouTube for 'transformer architecture explained' and summarize the top result"
```

### Explore a channel

```
"Show me the latest videos from @ThePrimeagen and get the chapters for the most recent one"
```

### Deep content analysis

```
"Get the transcript and chapters for this video, then create a structured summary"
```

### Audience sentiment

```
"What are the top comments on this video? What does the audience think?"
```

### Download a video (local only)

```
"Download this video in 1080p: https://youtube.com/watch?v=ABC123"
```

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## Development

```bash
npm run dev        # Watch mode
npm run build      # Build for production
npm run rebuild    # Clean and rebuild
npm start          # Run server (stdio)
npm run start:http # Run server (HTTP)
npm run validate   # Typecheck + lint + test
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Run tests (`npm run validate`)
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube extraction
- [Anthropic](https://anthropic.com) for the Model Context Protocol
