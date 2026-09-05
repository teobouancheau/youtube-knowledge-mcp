import { accessSync, constants, statSync } from 'node:fs';
import { envEnum, envString } from './env.js';
import { assertInsideHome } from './validate.js';

/**
 * The session options yt-dlp is started with, read from the environment.
 *
 * Cookies are how yt-dlp reads age-restricted, members-only and sign-in-gated
 * videos, and how it gets past the "confirm you're not a bot" check YouTube
 * sometimes applies to an address. They are also the user's own account, so
 * everything here is careful about two things: the values are validated at
 * boot and never at request time, and neither the cookie path nor its contents
 * ever appear in a log line, a tool result or an error message.
 */

export const COOKIE_BROWSERS = [
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
] as const;

export type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

export interface YtDlpEnv {
  /** The flags to place before the caller's arguments on every spawn. */
  args: string[];
  /** Which kind of cookies are configured; safe to report, unlike the values. */
  cookies: 'file' | 'browser' | 'none';
  browser?: CookieBrowser;
  proxy: boolean;
  /** Seconds yt-dlp sleeps between its own requests, when configured. */
  sleepRequestsSeconds?: number;
}

function readCookiesFile(env: NodeJS.ProcessEnv): string | undefined {
  const raw = envString('YOUTUBE_MCP_COOKIES_FILE', env);
  if (raw === undefined) return undefined;

  // The message names the variable and never the path: the path is the one
  // thing about a cookies file that should not travel.
  const rejected = (reason: string): Error =>
    new Error(
      `YOUTUBE_MCP_COOKIES_FILE ${reason}. Point it at a readable cookies file in your home directory.`
    );

  let path: string;
  try {
    path = assertInsideHome(raw, 'cookies file');
  } catch {
    throw rejected('must be inside your home directory');
  }

  try {
    if (!statSync(path).isFile()) throw rejected('is not a regular file');
    accessSync(path, constants.R_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('YOUTUBE_MCP_COOKIES_FILE')) throw error;
    throw rejected('could not be read');
  }

  return path;
}

function readProxy(env: NodeJS.ProcessEnv): string | undefined {
  const raw = envString('YOUTUBE_MCP_PROXY', env);
  if (raw === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('YOUTUBE_MCP_PROXY must be a URL such as socks5h://127.0.0.1:1080.');
  }
  if (!PROXY_SCHEMES.has(url.protocol)) {
    throw new Error(
      `YOUTUBE_MCP_PROXY must use one of ${[...PROXY_SCHEMES].map((s) => s.slice(0, -1)).join(', ')}.`
    );
  }
  return url.toString();
}

function readSleep(env: NodeJS.ProcessEnv): number | undefined {
  const raw = envString('YOUTUBE_MCP_SLEEP_REQUESTS_S', env);
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('YOUTUBE_MCP_SLEEP_REQUESTS_S must be a non-negative number of seconds.');
  }
  return seconds;
}

/**
 * Validate the session settings and turn them into yt-dlp flags.
 *
 * Throws a plain `Error` naming the variable: this runs at boot, where a bad
 * setting should stop the server before a transport starts, not surface as a
 * puzzling failure on the first tool call.
 */
export function readYtDlpEnv(env: NodeJS.ProcessEnv = process.env): YtDlpEnv {
  const cookiesFile = readCookiesFile(env);
  const browser = envEnum('YOUTUBE_MCP_COOKIES_FROM_BROWSER', COOKIE_BROWSERS, env);
  const proxy = readProxy(env);
  const sleep = readSleep(env);

  if (cookiesFile !== undefined && browser !== undefined) {
    throw new Error(
      'Set either YOUTUBE_MCP_COOKIES_FILE or YOUTUBE_MCP_COOKIES_FROM_BROWSER, not both.'
    );
  }

  const args: string[] = [];
  if (cookiesFile !== undefined) args.push('--cookies', cookiesFile);
  if (browser !== undefined) args.push('--cookies-from-browser', browser);
  if (proxy !== undefined) args.push('--proxy', proxy);
  if (sleep !== undefined) args.push('--sleep-requests', String(sleep));

  return {
    args,
    cookies: cookiesFile !== undefined ? 'file' : browser !== undefined ? 'browser' : 'none',
    ...(browser === undefined ? {} : { browser }),
    proxy: proxy !== undefined,
    ...(sleep === undefined ? {} : { sleepRequestsSeconds: sleep }),
  };
}

/** One line for the boot log: what is configured, never what it is. */
export function describeYtDlpEnv(settings: YtDlpEnv): string {
  const cookies =
    settings.cookies === 'browser'
      ? `browser (${settings.browser ?? 'unknown'})`
      : settings.cookies;
  const parts = [`yt-dlp cookies: ${cookies}`, `proxy: ${settings.proxy ? 'configured' : 'none'}`];
  if (settings.sleepRequestsSeconds !== undefined) {
    parts.push(`sleep between requests: ${settings.sleepRequestsSeconds}s`);
  }
  return parts.join(' · ');
}
