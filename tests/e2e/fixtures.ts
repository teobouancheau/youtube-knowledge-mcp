/**
 * The public targets the lane runs against.
 *
 * What is written here was observed, not assumed. Each entry says how and
 * when it was verified; `fixtures.e2e.ts` re-verifies those properties first,
 * so a target that changed on YouTube fails by name rather than breaking the
 * specs that depend on it.
 *
 * Verified on 2026-09-05 with yt-dlp 2026.07.04, from a network address whose
 * flat channel listings succeeded while per-video extraction was answered with
 * YouTube's bot check. Properties marked "run-time" could therefore not be
 * confirmed that day and are asserted by the fixture spec when the lane runs
 * (with cookies configured where the runner needs them).
 */

export const CHANNEL = {
  /** `yt-dlp -J --flat-playlist --playlist-items 0 -- https://www.youtube.com/@Google/videos` */
  handle: '@Google',
  id: 'UCK8sQmJBp8GCxrOtXWBpyEA',
  name: 'Google',
};

/** Listed under @Google/videos on 2026-09-05: duration 86, two thumbnails (360x202, 720x404). */
export const VIDEO = {
  id: 'rPq7ITrWFvY',
  url: 'https://www.youtube.com/watch?v=rPq7ITrWFvY',
  /** Run-time: whether it has captions, and in which languages. */
  captionsExpected: true,
};

/** Listed under @Google/shorts on 2026-09-05 with portrait thumbnails (405x720). */
export const SHORT = { id: '7k1sXY-ZCkI' };

/** Listed under @Google/streams on 2026-09-05 with live_status was_live. */
export const STREAM = { id: 'wYSncx9zLIU' };

/** Probed with curl -I on 2026-09-05: maxresdefault, sddefault and hqdefault all answered 200. */
export const THUMBNAIL_URLS = {
  maxres: `https://i.ytimg.com/vi/${VIDEO.id}/maxresdefault.jpg`,
};

/** Run-time: a playlist on the channel; the fixture spec discovers one from the listing. */
export const PLAYLIST_SEARCH = 'Google Search';
