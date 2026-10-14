/**
 * What a commit message must look like, enforced on every commit by the commit-msg hook
 * and on every commit about to be pushed by the pre-push hook.
 *
 * Conventional Commits, with the types the project uses, a header that fits a terminal and
 * a body that wraps. And no attribution: no co-author trailer and no "generated with" line,
 * anywhere in a commit of this repository.
 */

const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'];
const HEADER_MAX_LENGTH = 72;
const BODY_MAX_LINE_LENGTH = 100;

const ATTRIBUTION = /co-authored-by:|generated with|🤖/i;

/** A commitlint rule: the message must carry no attribution line of any kind. */
function noAttribution(parsed) {
  const line = (parsed.raw ?? '').split('\n').find((text) => ATTRIBUTION.test(text));
  return [
    line === undefined,
    `the message carries an attribution line, which this repository does not allow: "${line ?? ''}"`,
  ];
}

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [{ rules: { 'no-attribution': noAttribution } }],
  rules: {
    'type-enum': [2, 'always', TYPES],
    'header-max-length': [2, 'always', HEADER_MAX_LENGTH],
    'body-max-line-length': [2, 'always', BODY_MAX_LINE_LENGTH],
    // Warnings in the shared config, which a commit passes with: here they refuse.
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
    'no-attribution': [2, 'always'],
  },
};
