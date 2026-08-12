# Codex Instructions

## Project Overview

YouTube Knowledge Extractor is an MCP Server for extracting and managing YouTube video knowledge.

## Tech Stack

- **Runtime**: Node.js 22+ with ESM modules (`.nvmrc` pins 24 for development)
- **Language**: TypeScript (strict mode)
- **MCP SDK**: @modelcontextprotocol/sdk
- **Validation**: Zod
- **YouTube**: yt-dlp (external dependency)

## Project Structure

```
src/
├── cli.ts                # Executable entry (`bin`); never import it
├── index.ts              # MCP server construction; safe to import
├── tools/                # MCP tool implementations
│   ├── fetch-videos.ts
│   ├── get-transcript.ts
│   ├── get-video-info.ts
│   ├── list-library.ts
│   └── save-to-library.ts
└── utils/
    ├── storage.ts        # Library storage management
    └── youtube.ts        # yt-dlp wrapper
```

## Development Commands

```bash
npm run build    # Build TypeScript
npm run dev      # Watch mode
npm run rebuild  # Clean and rebuild
npm start        # Run server
```

## Git Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style (formatting)
- `refactor:` Code refactoring
- `test:` Adding/updating tests
- `chore:` Maintenance tasks

**IMPORTANT: Never include Co-Authored-By or any Codex attribution in commits.**

## Coding Standards

- Use 2 spaces for indentation
- Use single quotes for strings
- Add trailing commas
- Explicit return types for functions
- Use `const` over `let`

## MCP Tool Pattern

When adding new tools:

1. Create file in `src/tools/`
2. Export schema (Zod) and handler separately
3. Register in `src/index.ts`

```typescript
import { z } from 'zod';

export const myToolSchema = {
  param: z.string().describe('Description'),
};

export async function myToolHandler({ param }: { param: string }) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}
```

## Important Notes

- Never write to stdout in STDIO servers (use console.error for logging)
- Transcripts are cached in `~/.youtube-knowledge/transcripts/`
- Library content is stored in `~/.youtube-knowledge/library/`
