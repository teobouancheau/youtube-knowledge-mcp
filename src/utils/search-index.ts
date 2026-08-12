/**
 * Full-text search over the local library.
 *
 * A hand-written BM25 index rather than SQLite FTS5 or an embedding store:
 * `node:sqlite` needs Node 22 and this release still supports Node 20, and
 * embeddings would mean an API key and a heavyweight dependency for a server
 * whose whole appeal is four runtime dependencies. BM25 over a few thousand
 * saved notes is instant and costs nothing.
 */

import { z } from 'zod';

export const indexedDocumentSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  title: z.string(),
  /** 'summary' | 'skill' | 'transcript' */
  kind: z.string(),
  text: z.string(),
});

export type IndexedDocument = z.infer<typeof indexedDocumentSchema>;

/**
 * The serialised index. A malformed document costs its own row rather than the
 * whole index — the index is a cache and is rebuilt from the library, so
 * dropping one entry degrades ranking rather than losing anything.
 */
const serialisedIndexSchema = z.object({
  documents: z.array(z.unknown()),
});

export interface SearchHit {
  id: string;
  videoId: string;
  title: string;
  kind: string;
  score: number;
  /** A window of the document around the strongest match. */
  excerpt: string;
}

// Standard BM25 constants: k1 controls term-frequency saturation, b the degree
// of length normalisation.
const K1 = 1.5;
const B = 0.75;

/** Words carrying no discriminating power, which would otherwise dominate. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'you',
  'your',
  'i',
  'we',
  'they',
  'so',
  'if',
  'not',
  'can',
  'do',
  'does',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

interface Posting {
  /** Document id -> term frequency. */
  frequencies: Map<string, number>;
}

export class SearchIndex {
  private readonly documents = new Map<string, IndexedDocument & { length: number }>();
  private readonly postings = new Map<string, Posting>();

  add(document: IndexedDocument): void {
    this.remove(document.id);

    // Title terms are worth more than body terms; repeating the title is the
    // cheapest way to weight them without a second scoring pass.
    const tokens = [
      ...tokenize(document.title),
      ...tokenize(document.title),
      ...tokenize(document.text),
    ];
    this.documents.set(document.id, { ...document, length: tokens.length });

    for (const token of tokens) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = { frequencies: new Map() };
        this.postings.set(token, posting);
      }
      posting.frequencies.set(document.id, (posting.frequencies.get(document.id) ?? 0) + 1);
    }
  }

  remove(id: string): void {
    if (!this.documents.has(id)) return;
    this.documents.delete(id);

    for (const [term, posting] of this.postings) {
      posting.frequencies.delete(id);
      if (posting.frequencies.size === 0) this.postings.delete(term);
    }
  }

  get size(): number {
    return this.documents.size;
  }

  search(query: string, limit = 10): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.documents.size === 0) return [];

    const totalDocuments = this.documents.size;
    const averageLength =
      [...this.documents.values()].reduce((sum, document) => sum + document.length, 0) /
      totalDocuments;

    const scores = new Map<string, number>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const documentFrequency = posting.frequencies.size;
      const idf = Math.log(
        1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5)
      );

      for (const [id, frequency] of posting.frequencies) {
        const document = this.documents.get(id);
        if (!document) continue;

        const normalisation = K1 * (1 - B + (B * document.length) / (averageLength || 1));
        const score = idf * ((frequency * (K1 + 1)) / (frequency + normalisation));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .flatMap(([id, score]) => {
        const document = this.documents.get(id);
        if (!document) return [];
        return [
          {
            id,
            videoId: document.videoId,
            title: document.title,
            kind: document.kind,
            score: Math.round(score * 1000) / 1000,
            excerpt: excerptAround(document.text, terms),
          },
        ];
      });
  }

  /** Serialisable form. Postings are rebuilt on load rather than stored. */
  toJSON(): { version: number; documents: IndexedDocument[] } {
    return {
      version: 1,
      documents: [...this.documents.values()].map(({ length: _length, ...document }) => document),
    };
  }

  static fromJSON(value: unknown): SearchIndex {
    const index = new SearchIndex();

    const parsed = serialisedIndexSchema.safeParse(value);
    if (!parsed.success) return index;

    for (const document of parsed.data.documents) {
      const row = indexedDocumentSchema.safeParse(document);
      if (row.success) index.add(row.data);
    }
    return index;
  }
}

/** A readable window around the first query term found in the document. */
export function excerptAround(text: string, terms: string[], radius = 120): string {
  const haystack = text.toLowerCase();
  let position = -1;

  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found !== -1 && (position === -1 || found < position)) position = found;
  }

  if (position === -1) return text.slice(0, radius * 2).trim();

  const from = Math.max(0, position - radius);
  const to = Math.min(text.length, position + radius);

  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}
