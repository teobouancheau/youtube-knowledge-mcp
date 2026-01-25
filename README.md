# YouTube Knowledge MCP

[![npm version](https://img.shields.io/npm/v/youtube-knowledge-mcp.svg)](https://www.npmjs.com/package/youtube-knowledge-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/teobouancheau/youtube-knowledge-mcp?style=social)](https://github.com/teobouancheau/youtube-knowledge-mcp)

A Model Context Protocol (MCP) server that gives AI assistants the ability to extract knowledge from YouTube videos. Works with Claude Desktop, Claude Code, Cursor and any MCP-compatible client. Fetch video metadata, extract transcripts, download videos, and build a personal knowledge library from YouTube content.

![YouTube Knowledge MCP](https://raw.githubusercontent.com/teobouancheau/youtube-knowledge-mcp/main/thumbnail.png)

## Features

- **Fetch videos** from playlists or channels
- **Get video info** (title, channel, duration, description, tags)
- **Extract transcripts** (auto-generated or manual captions)
- **Download videos** with quality selection and format options
- **Save to library** (summaries, notes, skills)
- **List library** with tag filtering

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

### With npx (Recommended)

Add to your Claude Code MCP configuration:

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

### With npm global

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "youtube-knowledge-mcp"
    }
  }
}
```

### From source

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "node",
      "args": ["/path/to/youtube-knowledge-mcp/dist/index.js"]
    }
  }
}
```

Then restart Claude Code to load the new MCP server.

## MCP Tools

### youtube_fetch_videos

List videos from a YouTube playlist or channel.

| Parameter | Type   | Default  | Description                     |
| --------- | ------ | -------- | ------------------------------- |
| `url`     | string | required | YouTube playlist or channel URL |
| `limit`   | number | 20       | Maximum videos to fetch         |

### youtube_get_video_info

Get detailed metadata for a YouTube video.

| Parameter | Type   | Description     |
| --------- | ------ | --------------- |
| `video`   | string | Video ID or URL |

**Returns:** title, channel, duration, description, tags, thumbnail

### youtube_get_transcript

Extract transcript/subtitles from a YouTube video.

| Parameter  | Type   | Default  | Description             |
| ---------- | ------ | -------- | ----------------------- |
| `video`    | string | required | Video ID or URL         |
| `language` | string | "en"     | Preferred language code |

### youtube_list_formats

List available download formats for a YouTube video.

| Parameter | Type   | Description     |
| --------- | ------ | --------------- |
| `video`   | string | Video ID or URL |

**Returns:** format IDs, resolutions, codecs, file sizes

### youtube_download_video

Download a YouTube video with quality selection.

| Parameter   | Type   | Default  | Description                                                         |
| ----------- | ------ | -------- | ------------------------------------------------------------------- |
| `video`     | string | required | Video ID or URL                                                     |
| `quality`   | string | "best"   | Quality preset (best, 2160p, 1440p, 1080p, 720p, 480p, 360p, audio) |
| `formatId`  | string | -        | Specific format code from youtube_list_formats                      |
| `outputDir` | string | -        | Custom output directory                                             |

### youtube_save_to_library

Save content to your personal YouTube knowledge library.

| Parameter      | Type     | Description           |
| -------------- | -------- | --------------------- |
| `video_id`     | string   | YouTube video ID      |
| `title`        | string   | Video title           |
| `content`      | string   | Content to save       |
| `content_type` | string   | "summary" or "skill"  |
| `tags`         | string[] | Optional tags         |
| `channel`      | string   | Optional channel name |

### youtube_list_library

List all saved items in your library.

| Parameter | Type   | Description            |
| --------- | ------ | ---------------------- |
| `tag`     | string | Optional filter by tag |

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

### Quick summary

```
"Summarize this video: https://youtube.com/watch?v=ABC123"
```

### Explore a channel

```
"Show me the latest videos from @ThePrimeagen"
```

### Download a video

```
"Download this video in 1080p: https://youtube.com/watch?v=ABC123"
```

### Save to library

```
"Save this summary with tags: programming, productivity"
```

### Create a skill

```
"Create a Claude Code skill from this video's content"
```

## Development

```bash
npm run dev      # Watch mode
npm run build    # Build for production
npm run rebuild  # Clean and rebuild
npm start        # Run the server
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Run tests (`npm test`)
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

**Attribution appreciated!** If you use YouTube Knowledge MCP, consider:

- ⭐ Starring this repository
- 💬 Mentioning it in your project
- 🔗 Linking back to this repo

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for the powerful YouTube extraction
- [Anthropic](https://anthropic.com) for the Model Context Protocol
- All contributors and users of this project

---

<div align="center">
  <strong>Built with ❤️ by <a href="https://github.com/teobouancheau">teobouancheau</a> for the YouTube community</strong>
  <br>
  <sub>AI + YouTube knowledge to supercharge content creation</sub>
</div>
