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
- Leaking a cookies file's path or contents, or a proxy URL, through output or logs
- Fetching an image from a host outside YouTube's image hosts, or following a redirect to one

## Deployment notes

The HTTP transport binds `127.0.0.1` by default. It refuses to start on any
other interface without `MCP_AUTH_TOKEN`, unless `MCP_ALLOW_UNAUTHENTICATED=true`
says that is intended. When you expose it:

- Set `MCP_AUTH_TOKEN` to a high-entropy secret. Unauthenticated callers get a
  liveness answer from `/health` and nothing else.
- Set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` to enable DNS-rebinding
  protection.
- Behind a reverse proxy, set `MCP_TRUST_PROXY` to the number of hops so the
  rate limiter keys on the real client, and `MCP_PUBLIC_URL` so the OAuth
  metadata names the public address rather than echoing a request header.
- `MCP_MAX_BODY_BYTES` caps request bodies (1 MiB by default).

Every yt-dlp invocation places the target after a literal `--`, and every
caller-supplied URL must resolve to a YouTube host before yt-dlp is spawned, so
the server cannot be pointed at internal addresses.

Local-only tools — the knowledge library, downloads and clip extraction — are
never registered on the HTTP transport, so a remote deployment cannot reach the
host's filesystem through them.
