import { describe, it, expect } from 'vitest';
import {
  CoverageInvariantError,
  assertCoverageConsistent,
  coverageOf,
  RECEIPT_STALE_MS,
  type CoverageInput,
} from '../../src/utils/coverage.js';
import { renderCoverage } from '../../src/utils/coverage-text.js';
import { coverageSchema } from '../../src/harvest-schemas.js';

/**
 * The most important test in the codebase.
 *
 * A wrong `complete: true` is the one failure that turns a sample into a
 * claimed full history, so completeness is tested as a matrix over every
 * combination that could produce it rather than with a few happy paths.
 */

const AT = new Date('2026-09-06T12:00:00.000Z');

function build(overrides: Partial<CoverageInput> = {}): CoverageInput {
  return {
    scope: 'video-comments',
    targetId: 'dQw4w9WgXcQ',
    have: 0,
    source: 'yt-dlp 2026.08.19 --write-comments',
    harvestedAt: AT,
    ...overrides,
  };
}

describe('completeness matrix', () => {
  const cases: {
    name: string;
    input: Partial<CoverageInput>;
    complete: boolean;
    reason: string;
  }[] = [
    {
      name: 'source stated a total and we hold it',
      input: { have: 120, expected: { value: 120, source: 'youtube:comment_count' } },
      complete: true,
      reason: 'COMPLETE',
    },
    {
      name: 'we hold more than the source claimed (counts lag)',
      input: { have: 130, expected: { value: 120, source: 'youtube:comment_count' } },
      complete: true,
      reason: 'COMPLETE',
    },
    {
      name: 'we hold fewer than the source claimed',
      input: { have: 119, expected: { value: 120, source: 'youtube:comment_count' } },
      complete: false,
      reason: 'SOURCE_SILENT',
    },
    {
      name: 'the listing ran out on its own',
      input: {
        have: 42,
        expected: { value: 42, source: 'source-exhausted' },
        ranToExhaustion: true,
      },
      complete: true,
      reason: 'COMPLETE',
    },
    {
      name: 'no total at all — absence of evidence is not completeness',
      input: { have: 5_000 },
      complete: false,
      reason: 'SOURCE_SILENT',
    },
    {
      name: 'a binding cap defeats a met total',
      // The measured false positive: a capped run still reports that its
      // iteration finished, because islice ends it the same way.
      input: {
        have: 58,
        limitApplied: 58,
        expected: { value: 58, source: 'youtube:comment_count' },
        ranToExhaustion: true,
      },
      complete: false,
      reason: 'CAP_REACHED',
    },
    {
      name: 'a binding cap defeats an exhausted source',
      input: {
        have: 40,
        limitApplied: 40,
        expected: { value: 40, source: 'source-exhausted' },
        ranToExhaustion: true,
      },
      complete: false,
      reason: 'CAP_REACHED',
    },
    {
      name: 'a non-binding cap does not',
      input: {
        have: 39,
        limitApplied: 40,
        expected: { value: 39, source: 'youtube:comment_count' },
      },
      complete: true,
      reason: 'COMPLETE',
    },
    {
      name: 'an interrupted run cannot be complete even at an exhausted source',
      input: {
        have: 30,
        expected: { value: 30, source: 'source-exhausted' },
        ranToExhaustion: false,
      },
      complete: false,
      reason: 'SOURCE_SILENT',
    },
    {
      name: 'an explicit stop reason survives',
      input: { have: 12, reason: 'RATE_LIMITED' },
      complete: false,
      reason: 'RATE_LIMITED',
    },
    {
      name: 'zero of zero is complete when the source says zero',
      input: { have: 0, expected: { value: 0, source: 'youtube:comment_count' } },
      complete: true,
      reason: 'COMPLETE',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.complete ? 'complete' : 'incomplete'}: ${testCase.name}`, () => {
      const coverage = coverageOf(build({ ...testCase.input, resumeToken: 'more' }));

      expect(coverage.complete).toBe(testCase.complete);
      expect(coverage.reason).toBe(testCase.reason);
      expect(() => {
        assertCoverageConsistent(coverage);
      }).not.toThrow();
    });
  }

  it('never derives expected from have', () => {
    // The single rule that stops "we stopped" becoming "there was no more".
    const coverage = coverageOf(build({ have: 9_999 }));

    expect(coverage.expected).toBeUndefined();
    expect(coverage.expectedSource).toBeUndefined();
    expect(coverage.complete).toBe(false);
  });
});

describe('receipt fields', () => {
  it('carries a resume token only while incomplete', () => {
    expect(coverageOf(build({ have: 1, resumeToken: 'next' })).resumeToken).toBe('next');
    expect(
      coverageOf(
        build({
          have: 1,
          expected: { value: 1, source: 'youtube:comment_count' },
          resumeToken: 'next',
        })
      ).resumeToken
    ).toBeUndefined();
  });

  it('dates staleness only on a complete receipt', () => {
    const complete = coverageOf(
      build({ have: 1, expected: { value: 1, source: 'youtube:comment_count' } })
    );
    expect(complete.staleAfter).toBe(new Date(AT.getTime() + RECEIPT_STALE_MS).toISOString());
    expect(coverageOf(build({ have: 1 })).staleAfter).toBeUndefined();
  });

  it('round-trips through its own schema', () => {
    expect(coverageSchema.safeParse(coverageOf(build({ have: 3 }))).success).toBe(true);
  });
});

describe('assertCoverageConsistent', () => {
  const base = coverageOf(
    build({ have: 5, expected: { value: 5, source: 'youtube:comment_count' } })
  );

  const broken: { name: string; mutate: () => unknown }[] = [
    {
      name: 'complete with a non-COMPLETE reason',
      mutate: () => ({ ...base, reason: 'CAP_REACHED' }),
    },
    { name: 'COMPLETE reason while incomplete', mutate: () => ({ ...base, complete: false }) },
    {
      name: 'expected without expectedSource',
      mutate: () => ({ ...base, expectedSource: undefined }),
    },
    {
      name: 'complete without any proof',
      mutate: () => ({ ...base, expected: undefined, expectedSource: undefined }),
    },
    {
      name: 'complete with fewer than expected',
      mutate: () => ({ ...base, have: 1 }),
    },
    {
      name: 'a resume token on a complete receipt',
      mutate: () => ({ ...base, resumeToken: 'more' }),
    },
    {
      name: 'a binding cap producing COMPLETE',
      mutate: () => ({ ...base, limitApplied: 5 }),
    },
  ];

  for (const testCase of broken) {
    it(`rejects ${testCase.name}`, () => {
      const candidate = coverageSchema.parse(testCase.mutate());
      expect(() => {
        assertCoverageConsistent(candidate);
      }).toThrow(CoverageInvariantError);
    });
  }
});

describe('assertCoverageConsistent, remaining guards', () => {
  it('rejects a COMPLETE reason on an incomplete receipt', () => {
    // Hand-built rather than via coverageOf, which cannot produce this: the
    // guards exist for a receipt read back from disk or written by a future
    // caller, not for this module's own output.
    const candidate = coverageSchema.parse({
      scope: 'video-comments',
      targetId: 'v',
      complete: false,
      reason: 'COMPLETE',
      have: 3,
      source: 'test',
      harvestedAt: AT.toISOString(),
    });

    expect(() => {
      assertCoverageConsistent(candidate);
    }).toThrow(/reason is COMPLETE but complete is false/);
  });

  it('accepts an incomplete receipt with nothing to resume', () => {
    // SOURCE_REFUSED has no continuation, and demanding a token would force
    // callers to invent one.
    const refused = coverageOf(build({ have: 0, reason: 'SOURCE_REFUSED' }));

    expect(refused.resumeToken).toBeUndefined();
    expect(() => {
      assertCoverageConsistent(refused);
    }).not.toThrow();
  });
});

describe('renderCoverage', () => {
  it('names the right unit and warning for a channel catalog', () => {
    const text = renderCoverage(
      coverageOf({
        scope: 'channel-catalog',
        targetId: 'UCBJycsmduvYEL83R_U4JriQ',
        have: 1_716,
        source: 'yt-dlp --flat-playlist',
        harvestedAt: AT,
      })
    );

    expect(text).toContain('1,716 videos');
    expect(text).toContain('Do not describe this as the full video list');
  });

  it('does not print a percentage against a zero total', () => {
    const text = renderCoverage(
      coverageOf(build({ have: 0, expected: { value: 0, source: 'youtube:comment_count' } }))
    );

    expect(text).toContain('COMPLETE');
    expect(text).not.toContain('%');
  });

  it('omits "about" for a total the source did not estimate', () => {
    const text = renderCoverage(
      coverageOf(
        build({
          scope: 'channel-catalog',
          have: 12,
          expected: { value: 12, source: 'source-exhausted' },
          ranToExhaustion: true,
        })
      )
    );

    expect(text).toContain('12 of 12 videos');
    expect(text).not.toContain('about');
  });

  it('appends a note when one is given', () => {
    const text = renderCoverage(
      coverageOf(build({ have: 1, note: 'Continue with: harvest_comments maxComments=50000' }))
    );

    expect(text).toContain('Continue with: harvest_comments maxComments=50000');
  });
});

describe('renderCoverage, original cases', () => {
  it('tells the reader not to overclaim, in words', () => {
    const text = renderCoverage(
      coverageOf(
        build({
          have: 4_312,
          expected: { value: 128_904, source: 'youtube:comment_count' },
          limitApplied: 4_312,
          sortApplied: 'top',
        })
      )
    );

    expect(text).toContain('Coverage: 4,312 of about 128,904 comments (3.3%)');
    expect(text).toContain('INCOMPLETE');
    expect(text).toContain('biased prefix');
    expect(text).toContain('Do not describe this as the full comment history');
  });

  it('states completeness and when to re-check', () => {
    const text = renderCoverage(
      coverageOf(
        build({ have: 128_904, expected: { value: 128_904, source: 'youtube:comment_count' } })
      )
    );

    expect(text).toContain('COMPLETE');
    expect(text).toContain('Re-check after');
    expect(text).not.toContain('INCOMPLETE');
  });

  it('does not invent a percentage when no total is known', () => {
    const text = renderCoverage(coverageOf(build({ have: 12 })));

    expect(text).toContain('Coverage: 12 comments');
    expect(text).not.toContain('%');
    expect(text).toContain('cannot be proven');
  });

  it('avoids rounding a tiny fraction to 0.0%', () => {
    const text = renderCoverage(
      coverageOf(
        build({ have: 5, expected: { value: 2_400_000, source: 'youtube:comment_count' } })
      )
    );

    expect(text).toContain('<0.1%');
  });
});
