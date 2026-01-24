# YouTube Knowledge Extractor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

MCP Server for extracting and managing YouTube video knowledge in Claude Code.

## Features

- **Fetch videos** from playlists or channels
- **Get video info** (title, channel, duration, description, tags)
- **Extract transcripts** (auto-generated or manual captions)
- **Save to library** (summaries, notes, skills)
- **List library** with tag filtering

## Prerequisites

- Node.js 20+
- yt-dlp: `brew install yt-dlp` (macOS) or [see installation guide](https://github.com/yt-dlp/yt-dlp#installation)

## Installation

```bash
git clone https://github.com/teobouancheau/youtube-knowledge-extractor.git
cd youtube-knowledge-extractor
npm install
npm run build
```

## Configuration

### Option 1: Project-level (`.mcp.json`)

Add a `.mcp.json` file to your project root:

```json
{
  "mcpServers": {
    "youtube-knowledge": {
      "command": "node",
      "args": ["/path/to/youtube-knowledge-extractor/dist/index.js"]
    }
  }
}
```

### Option 2: Global configuration

Add to your Claude Code MCP configuration:

```json
{
  "youtube-knowledge": {
    "command": "node",
    "args": ["/path/to/youtube-knowledge-extractor/dist/index.js"]
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

### youtube_save_to_library

Save content to your personal YouTube knowledge library.

| Parameter      | Type     | Description          |
| -------------- | -------- | -------------------- |
| `video_id`     | string   | YouTube video ID     |
| `title`        | string   | Video title          |
| `content`      | string   | Content to save      |
| `content_type` | string   | "summary" or "skill" |
| `tags`         | string[] | Optional tags        |

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) © 2026 teobouancheau
