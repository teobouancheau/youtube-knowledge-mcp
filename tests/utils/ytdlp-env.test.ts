import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.TEST_HOME ?? actual.homedir() };
});

import { COOKIE_BROWSERS, describeYtDlpEnv, readYtDlpEnv } from '../../src/utils/ytdlp-env.js';

let home: string;
let outside: string;
let cookies: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'ytdlp-env-home-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'ytdlp-env-out-')));
  process.env.TEST_HOME = home;
  cookies = join(home, 'cookies.txt');
  await writeFile(cookies, '# Netscape HTTP Cookie File\n');
  await writeFile(join(outside, 'cookies.txt'), '');
  await symlink(join(outside, 'cookies.txt'), join(home, 'escape.txt'));
  await mkdir(join(home, 'dir'));
});

afterAll(async () => {
  delete process.env.TEST_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('readYtDlpEnv', () => {
  it('adds no flags when nothing is configured', () => {
    expect(readYtDlpEnv({})).toEqual({ args: [], cookies: 'none', proxy: false });
  });

  it('passes a readable cookies file inside home', () => {
    const settings = readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FILE: cookies });
    expect(settings.args).toEqual(['--cookies', cookies]);
    expect(settings.cookies).toBe('file');
  });

  it('expands a tilde in the cookies path', () => {
    expect(readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FILE: '~/cookies.txt' }).args).toEqual([
      '--cookies',
      cookies,
    ]);
  });

  // The path is the one thing about a cookies file that must not travel, so
  // every rejection names the variable and nothing else.
  it.each([
    ['a file outside home', () => join(outside, 'cookies.txt')],
    ['a symlink that escapes home', () => join(home, 'escape.txt')],
    ['a directory', () => join(home, 'dir')],
    ['a missing file', () => join(home, 'nope.txt')],
  ])('rejects %s without echoing the path', (_label, path) => {
    const error = (() => {
      try {
        readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FILE: path() });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('YOUTUBE_MCP_COOKIES_FILE');
    expect(error?.message).not.toContain(home);
    expect(error?.message).not.toContain(outside);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects an unreadable file',
    async () => {
      const locked = join(home, 'locked.txt');
      await writeFile(locked, '');
      await chmod(locked, 0o000);
      expect(() => readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FILE: locked })).toThrow(/could not be read/);
    }
  );

  it.each(COOKIE_BROWSERS)('accepts the browser %s', (browser) => {
    const settings = readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FROM_BROWSER: browser });
    expect(settings.args).toEqual(['--cookies-from-browser', browser]);
    expect(settings).toMatchObject({ cookies: 'browser', browser });
  });

  it('rejects a browser yt-dlp does not know', () => {
    expect(() => readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FROM_BROWSER: 'netscape' })).toThrow(
      /YOUTUBE_MCP_COOKIES_FROM_BROWSER/
    );
  });

  it('refuses both cookie sources at once', () => {
    expect(() =>
      readYtDlpEnv({
        YOUTUBE_MCP_COOKIES_FILE: cookies,
        YOUTUBE_MCP_COOKIES_FROM_BROWSER: 'chrome',
      })
    ).toThrow(/not both/);
  });

  it.each(['http://proxy.example:8080', 'socks5h://127.0.0.1:1080', 'socks4://p.example:1080'])(
    'accepts the proxy %s',
    (proxy) => {
      const settings = readYtDlpEnv({ YOUTUBE_MCP_PROXY: proxy });
      expect(settings.args[0]).toBe('--proxy');
      expect(settings.proxy).toBe(true);
    }
  );

  it.each(['ftp://p.example', 'not a url', 'file:///etc/passwd'])(
    'rejects the proxy %s',
    (proxy) => {
      expect(() => readYtDlpEnv({ YOUTUBE_MCP_PROXY: proxy })).toThrow(/YOUTUBE_MCP_PROXY/);
    }
  );

  it('passes a request pause through in seconds', () => {
    expect(readYtDlpEnv({ YOUTUBE_MCP_SLEEP_REQUESTS_S: '0.75' }).args).toEqual([
      '--sleep-requests',
      '0.75',
    ]);
  });

  it.each(['-1', 'slow', 'Infinity'])('rejects the pause %s', (value) => {
    expect(() => readYtDlpEnv({ YOUTUBE_MCP_SLEEP_REQUESTS_S: value })).toThrow(
      /YOUTUBE_MCP_SLEEP_REQUESTS_S/
    );
  });

  it('orders cookies before the proxy before the pause', () => {
    const settings = readYtDlpEnv({
      YOUTUBE_MCP_COOKIES_FROM_BROWSER: 'firefox',
      YOUTUBE_MCP_PROXY: 'http://p.example:1',
      YOUTUBE_MCP_SLEEP_REQUESTS_S: '1',
    });
    expect(settings.args).toEqual([
      '--cookies-from-browser',
      'firefox',
      '--proxy',
      'http://p.example:1/',
      '--sleep-requests',
      '1',
    ]);
  });
});

describe('describeYtDlpEnv', () => {
  it('reports kinds, never values', () => {
    const line = describeYtDlpEnv(
      readYtDlpEnv({
        YOUTUBE_MCP_COOKIES_FILE: cookies,
        YOUTUBE_MCP_PROXY: 'http://secret-host.example:1',
        YOUTUBE_MCP_SLEEP_REQUESTS_S: '2',
      })
    );
    expect(line).toContain('cookies: file');
    expect(line).toContain('proxy: configured');
    expect(line).toContain('2s');
    expect(line).not.toContain(home);
    expect(line).not.toContain('secret-host');
  });

  it('names the browser, which is not a secret', () => {
    expect(
      describeYtDlpEnv(readYtDlpEnv({ YOUTUBE_MCP_COOKIES_FROM_BROWSER: 'chrome' }))
    ).toContain('browser (chrome)');
  });
});
