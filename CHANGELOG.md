# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Continuous integration on every push and pull request (typecheck, lint,
  format check, tests with coverage, build, and a post-build smoke test that
  boots the compiled server as a real MCP client) across Node 20, 22, and 24.
- A weekly dependency audit job, Dependabot for npm and GitHub Actions, and
  `CODEOWNERS`.
- `.mcp.json.example`, referenced by `.gitignore` since the first release but
  never committed, and `.nvmrc`.

### Changed

- Every dependency updated to current; `@modelcontextprotocol/sdk` narrowed
  from `^1.0.0` (a range spanning 30 minor versions) to `^1.30.0`. Reported
  vulnerabilities went from 19 to 0.
- Linting now fails the build rather than warning: `--max-warnings 0`,
  `no-explicit-any` promoted to an error, explicit return types required, and
  `no-console` added so nothing can corrupt the stdio JSON-RPC stream.
  `format:check` is part of `npm run validate`.
- The Express app in HTTP mode is properly typed via `@types/express`,
  removing the codebase's only `eslint-disable`.

## [1.1.1] - 2025-11-15

### Fixed

- Missing `viewCount`, `likeCount`, and `commentCount` in test mocks.

## [1.1.0]

### Added

- Remote MCP support over Streamable HTTP, six new tools, and MCP tool
  annotations.
- Tests for all tools; tool parameters harmonized to camelCase.

## [1.0.2]

### Fixed

- Video and audio streams now merge correctly in MP4 downloads.

## [1.0.0]

Initial release.

[unreleased]: https://github.com/teobouancheau/youtube-knowledge-mcp/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/teobouancheau/youtube-knowledge-mcp/releases/tag/v1.1.1
