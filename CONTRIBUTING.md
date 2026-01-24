# Contributing to YouTube Knowledge Extractor

Thank you for your interest in contributing to this project!

## Getting Started

### Prerequisites

- Node.js 20+
- yt-dlp: `brew install yt-dlp`
- Git

### Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/teobouancheau/youtube-knowledge-extractor.git
   cd youtube-knowledge-extractor
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:

   ```bash
   npm run build
   ```

4. Run in development mode:
   ```bash
   npm run dev
   ```

## Project Structure

```
youtube-knowledge-extractor/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── tools/                # MCP tool implementations
│   │   ├── fetch-videos.ts
│   │   ├── get-transcript.ts
│   │   ├── get-video-info.ts
│   │   ├── list-library.ts
│   │   └── save-to-library.ts
│   └── utils/                # Utility functions
│       ├── storage.ts        # Library storage management
│       └── youtube.ts        # yt-dlp wrapper
├── dist/                     # Compiled output (git-ignored)
├── package.json
├── tsconfig.json
└── README.md
```

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template
3. Include:
   - Node.js version
   - yt-dlp version
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages/logs

### Suggesting Features

1. Open an issue with the feature request template
2. Describe the use case
3. Explain how it fits with existing functionality

### Submitting Changes

1. Fork the repository
2. Create a feature branch:

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. Make your changes following our coding standards

4. Build and test:

   ```bash
   npm run build
   ```

5. Commit with conventional commit messages:

   ```bash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve issue with transcripts"
   git commit -m "docs: update README"
   ```

6. Push and create a Pull Request

## Coding Standards

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer `const` over `let`
- Use explicit return types for functions
- Use descriptive variable names

### Code Style

- Use 2 spaces for indentation
- Use single quotes for strings
- Add trailing commas
- Keep functions small and focused

### MCP Tools

When adding new tools:

1. Create a new file in `src/tools/`
2. Export the schema and handler separately
3. Use Zod for input validation
4. Return consistent JSON structures
5. Register in `src/index.ts`

Example:

```typescript
import { z } from 'zod';

export const myToolSchema = {
  param: z.string().describe('Parameter description'),
};

export async function myToolHandler({ param }: { param: string }) {
  // Implementation
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `style:` Code style (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

## Testing

Currently, testing is manual:

1. Build the project
2. Configure in Claude Code settings
3. Test each tool with real YouTube URLs

Automated tests are welcome contributions!

## Questions?

Open an issue with the question label or reach out to the maintainers.
