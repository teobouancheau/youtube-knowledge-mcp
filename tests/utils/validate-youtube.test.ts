import { describe, it, expect } from 'vitest';
import {
  assertChannelId,
  assertVideoId,
  assertYouTubeUrl,
  YOUTUBE_HOSTS,
} from '../../src/utils/validate.js';
import { YouTubeError } from '../../src/utils/errors.js';

function caught(fn: () => unknown): YouTubeError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof YouTubeError ? error : undefined;
  }
}

describe('assertVideoId', () => {
  it.each(['dQw4w9WgXcQ', 'a-b_c123456', '___________'])('accepts %s', (id) => {
    expect(assertVideoId(id)).toBe(id);
  });

  // A video id becomes a directory name under the library, so anything that
  // could climb out of it has to be refused before it reaches a path join.
  it.each([
    '',
    '..',
    '../../etc',
    'x/y',
    'dQw4w9WgXc',
    'dQw4w9WgXcQQ',
    'dQw4w9WgXc.',
    'a b c d e f',
  ])('rejects %j', (id) => {
    const error = caught(() => assertVideoId(id));
    expect(error?.code).toBe('INVALID_INPUT');
  });

  it('does not echo an oversized value back', () => {
    const error = caught(() => assertVideoId('x'.repeat(500)));
    expect(error?.message.length).toBeLessThan(120);
  });
});

describe('assertChannelId', () => {
  it.each(['UCXuqSBlHAE6Xw-yeJA0Tunw', 'UC_x5XG1OV2P6uZZ5FSM9Ttw', 'UC-lHJZR3Gqxm24_Vd_AJ5Yw'])(
    'accepts the real channel id %s',
    (channelId) => {
      expect(assertChannelId(channelId)).toBe(channelId);
    }
  );

  it.each([
    '',
    'UC',
    'XCXuqSBlHAE6Xw-yeJA0Tunw',
    'UCXuqSBlHAE6Xw-yeJA0Tunww',
    'UCXuqSBlHAE6Xw yeJA0Tunw',
  ])('rejects the malformed id %s', (channelId) => {
    expect(() => assertChannelId(channelId)).toThrow(YouTubeError);
  });

  it.each(['../../etc/passwd', 'UC../../../etc', 'UC/../../secrets', 'UC\0AAAAAAAAAAAAAAAAAAAA'])(
    'rejects the traversal attempt %j',
    (channelId) => {
      expect(() => assertChannelId(channelId)).toThrow(YouTubeError);
    }
  );
});

describe('assertYouTubeUrl', () => {
  it.each(YOUTUBE_HOSTS)('accepts an https URL on %s', (host) => {
    expect(assertYouTubeUrl(`https://${host}/watch?v=dQw4w9WgXcQ`)).toBe(
      `https://${host}/watch?v=dQw4w9WgXcQ`
    );
  });

  it('upgrades http to https', () => {
    expect(assertYouTubeUrl('http://youtu.be/dQw4w9WgXcQ')).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('accepts a pasted URL without a scheme', () => {
    expect(assertYouTubeUrl('youtube.com/@Google/videos')).toBe(
      'https://youtube.com/@Google/videos'
    );
    expect(assertYouTubeUrl('www.youtube.com/playlist?list=PL123')).toBe(
      'https://www.youtube.com/playlist?list=PL123'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(assertYouTubeUrl('  https://www.youtube.com/@x  ')).toBe('https://www.youtube.com/@x');
  });

  // yt-dlp's generic extractor fetches whatever it is given, so a URL on any
  // other host is a request to make this server fetch something on the
  // caller's behalf. Internal addresses are the reason that matters.
  it.each([
    ['another host', 'https://evil.com/watch?v=dQw4w9WgXcQ'],
    ['a look-alike host', 'https://youtube.com.evil.com/'],
    ['a host that merely contains youtube', 'https://notyoutube.com/'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://localhost:8080/'],
    ['a file URL', 'file:///etc/passwd'],
    ['an ftp URL', 'ftp://youtube.com/'],
    ['credentials in the URL', 'https://user:pw@youtube.com/'],
    ['an explicit port', 'https://www.youtube.com:8443/'],
    ['a flag disguised as a URL', '--config-locations=/tmp/evil'],
    ['plain text', 'not a url'],
    ['an empty string', ''],
  ])('rejects %s', (_label, input) => {
    const error = caught(() => assertYouTubeUrl(input));
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.toToolMessage()).toContain('youtu.be');
  });
});
