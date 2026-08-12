import { describe, it, expect } from 'vitest';
import { SearchIndex, excerptAround, tokenize } from '../../src/utils/search-index.js';

function seeded(): SearchIndex {
  const index = new SearchIndex();
  index.add({
    id: 'v1:summary',
    videoId: 'v1',
    title: 'Rate limiting strategies',
    kind: 'summary',
    text: 'Token bucket and leaky bucket algorithms for throttling API requests at the edge.',
  });
  index.add({
    id: 'v2:summary',
    videoId: 'v2',
    title: 'Database indexing',
    kind: 'summary',
    text: 'B-trees, covering indexes and why a sequential scan sometimes beats an index.',
  });
  index.add({
    id: 'v3:skill',
    videoId: 'v3',
    title: 'Debugging distributed systems',
    kind: 'skill',
    text: 'Tracing requests across services, correlation IDs, and reading a flame graph.',
  });
  return index;
}

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('Hello, World! Foo-bar')).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('drops stop words, which would otherwise dominate scoring', () => {
    expect(tokenize('the quick and the dead')).toEqual(['quick', 'dead']);
  });

  it('drops single characters', () => {
    expect(tokenize('a b cd')).toEqual(['cd']);
  });

  it('keeps non-ASCII words', () => {
    expect(tokenize('café über 日本語')).toEqual(['café', 'über', '日本語']);
  });

  it('returns nothing for punctuation only', () => {
    expect(tokenize('!!! ...')).toEqual([]);
  });
});

describe('SearchIndex', () => {
  it('finds a document by a body term', () => {
    const hits = seeded().search('throttling');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.videoId).toBe('v1');
  });

  it('finds a document by a title term', () => {
    expect(seeded().search('indexing')[0]?.videoId).toBe('v2');
  });

  it('ranks a title match above an incidental body match', () => {
    const index = seeded();
    index.add({
      id: 'v4:summary',
      videoId: 'v4',
      title: 'Unrelated topic',
      kind: 'summary',
      text: 'A passing mention of indexing buried in the middle of other content.',
    });

    expect(index.search('indexing')[0]?.videoId).toBe('v2');
  });

  it('scores multi-term queries higher when more terms match', () => {
    const hits = seeded().search('bucket algorithms');
    expect(hits[0]?.videoId).toBe('v1');
  });

  it('returns nothing for a query of only stop words', () => {
    expect(seeded().search('the and of')).toEqual([]);
  });

  it('returns nothing when no document matches', () => {
    expect(seeded().search('kubernetes')).toEqual([]);
  });

  it('returns nothing when the index is empty', () => {
    expect(new SearchIndex().search('anything')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(seeded().search('and', 1).length).toBeLessThanOrEqual(1);
  });

  it('includes an excerpt around the match', () => {
    expect(seeded().search('leaky')[0]?.excerpt).toContain('leaky');
  });

  it('replaces a document rather than duplicating it', () => {
    const index = seeded();
    index.add({
      id: 'v1:summary',
      videoId: 'v1',
      title: 'Rate limiting strategies',
      kind: 'summary',
      text: 'Rewritten to talk about circuit breakers instead.',
    });

    expect(index.size).toBe(3);
    expect(index.search('throttling')).toEqual([]);
    expect(index.search('breakers')).toHaveLength(1);
  });

  it('removes a document and its postings', () => {
    const index = seeded();
    index.remove('v1:summary');

    expect(index.size).toBe(2);
    expect(index.search('throttling')).toEqual([]);
  });

  it('ignores removal of an unknown document', () => {
    const index = seeded();
    index.remove('does-not-exist');
    expect(index.size).toBe(3);
  });

  it('survives a round trip through JSON', () => {
    const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(seeded().toJSON())));

    expect(restored.size).toBe(3);
    expect(restored.search('throttling')[0]?.videoId).toBe('v1');
  });

  it.each([null, undefined, 42, 'string', {}, { documents: 'not an array' }])(
    'returns an empty index for malformed persisted data (%s)',
    (value) => {
      expect(SearchIndex.fromJSON(value).size).toBe(0);
    }
  );

  it('skips malformed documents rather than failing the load', () => {
    const restored = SearchIndex.fromJSON({
      documents: [
        { id: 'ok', videoId: 'v', title: 't', kind: 'summary', text: 'real content here' },
        { id: 'broken' },
        null,
      ],
    });

    expect(restored.size).toBe(1);
  });
});

describe('excerptAround', () => {
  const text = 'a'.repeat(300) + ' NEEDLE ' + 'b'.repeat(300);

  it('centres the window on the match', () => {
    expect(excerptAround(text, ['needle'])).toContain('NEEDLE');
  });

  it('marks both elisions', () => {
    const excerpt = excerptAround(text, ['needle']);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('falls back to the head of the document when no term is present', () => {
    expect(excerptAround('short document text', ['absent'])).toBe('short document text');
  });

  it('uses the earliest matching term', () => {
    expect(excerptAround('alpha beta gamma', ['gamma', 'alpha'])).toContain('alpha');
  });
});
