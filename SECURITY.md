# Security Policy

## Supported versions

Security fixes are applied to the latest published release.

## Reporting a vulnerability

Please report security issues privately rather than in a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/teobouancheau/youtube-knowledge-mcp/security/advisories/new)
for this repository. You should get an acknowledgement within a few days.

Please include what an attacker could do, the steps to reproduce it, and the
version and platform you saw it on.

## Scope

This server spawns `yt-dlp` and `ffmpeg`, writes files under your home
directory, and optionally listens on HTTP. Reports about any of the following
are in scope:

- Escaping the home directory when writing downloads, clips, frames or subtitles
- Command or argument injection into `yt-dlp` or `ffmpeg`
- Reaching the local filesystem, or any local-only tool, through the HTTP transport
- Bypassing bearer authentication when `MCP_AUTH_TOKEN` is set
- Leaking local paths, tokens or command lines through tool output

## Deployment notes

The HTTP transport is unauthenticated unless you set `MCP_AUTH_TOKEN`, and it
binds `0.0.0.0` by default so it works inside a container. If you expose it
beyond localhost:

- Set `MCP_AUTH_TOKEN` to a high-entropy secret.
- Set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` to enable DNS-rebinding
  protection.
- Set `MCP_BIND_HOST=127.0.0.1` if a reverse proxy is terminating traffic.

Local-only tools — the knowledge library, downloads and clip extraction — are
never registered on the HTTP transport, so a remote deployment cannot reach the
host's filesystem through them.
