import { describe, it, expect } from 'vitest';
import { toCsv, toMarkdownTable, type Column } from '../../src/utils/export-format.js';

interface Row {
  id: string;
  text: string;
  likes: number;
  pinned: boolean;
  note?: string;
}

const COLUMNS: Column<Row>[] = [
  { header: 'id', value: (row) => row.id },
  { header: 'text', value: (row) => row.text },
  { header: 'likes', value: (row) => row.likes },
  { header: 'pinned', value: (row) => row.pinned },
  { header: 'note', value: (row) => row.note },
];

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'c1',
  text: 'nice video',
  likes: 3,
  pinned: false,
  ...overrides,
});

const lines = (csv: string): string[] => csv.split('\r\n');

describe('toCsv', () => {
  it('writes a header row, then one CRLF-ended row per record, as RFC 4180 has it', () => {
    const csv = toCsv(COLUMNS, [row(), row({ id: 'c2' })]);

    expect(csv).toBe(
      'id,text,likes,pinned,note\r\nc1,nice video,3,false,\r\nc2,nice video,3,false,\r\n'
    );
  });

  it('quotes a field that holds a comma, a quote or a line break, doubling inner quotes', () => {
    const csv = toCsv(COLUMNS, [
      row({ text: 'a, b' }),
      row({ text: 'say "hi"' }),
      row({ text: 'two\nlines' }),
    ]);

    expect(csv).toContain('"a, b"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"two\nlines"');
  });

  it('leaves a plain field unquoted', () => {
    expect(lines(toCsv(COLUMNS, [row()]))[1]).toBe('c1,nice video,3,false,');
  });

  it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@cmd', '\tinjected', '\rinjected'])(
    'defuses a text field that a spreadsheet would run as a formula: %j',
    (text) => {
      const csv = toCsv([{ header: 'text', value: (r: Row) => r.text }], [row({ text })]);

      // A leading apostrophe makes every spreadsheet show the text instead of running it.
      const body = csv.slice('text\r\n'.length);
      expect(body.startsWith(`'${text}`) || body.startsWith(`"'${text}`)).toBe(true);
    }
  );

  it('does not touch numbers, including negative ones, since they are not text', () => {
    const csv = toCsv([{ header: 'n', value: (r: Row) => r.likes }], [row({ likes: -4 })]);

    expect(csv).toBe('n\r\n-4\r\n');
  });

  it('writes a missing value as an empty field and a boolean as its word', () => {
    expect(lines(toCsv(COLUMNS, [row({ note: undefined, pinned: true })]))[1]).toBe(
      'c1,nice video,3,true,'
    );
  });

  it('keeps a verbatim column exact, so an id that begins with a dash is not turned into another id', () => {
    const csv = toCsv(
      [{ header: 'id', value: (r: Row) => r.id, verbatim: true }],
      [row({ id: '-abc_DEF123' }), row({ id: '=looks-like-formula' })]
    );

    expect(csv).toBe('id\r\n-abc_DEF123\r\n=looks-like-formula\r\n');
  });

  it('writes only the header for no rows', () => {
    expect(toCsv(COLUMNS, [])).toBe('id,text,likes,pinned,note\r\n');
  });

  it('defuses a formula in a header too, though headers are ours', () => {
    expect(toCsv([{ header: '=bad', value: () => 'x' }], [{}])).toContain("'=bad");
  });
});

describe('toMarkdownTable', () => {
  it('writes a header, a separator and a row per record', () => {
    const table = toMarkdownTable(COLUMNS, [row()]);

    expect(table.split('\n')).toEqual([
      '| id | text | likes | pinned | note |',
      '| --- | --- | --- | --- | --- |',
      '| c1 | nice video | 3 | false |  |',
    ]);
  });

  it('keeps a pipe in the text from ending the cell', () => {
    expect(toMarkdownTable(COLUMNS, [row({ text: 'a | b' })])).toContain('a \\| b');
  });

  it('keeps a line break in the text from ending the row', () => {
    const table = toMarkdownTable(COLUMNS, [row({ text: 'two\nlines\r\nhere' })]);

    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('two lines here');
  });

  it('keeps a backslash from escaping the pipe that follows it', () => {
    expect(toMarkdownTable(COLUMNS, [row({ text: 'back\\| slash' })])).toContain(
      'back\\\\\\| slash'
    );
  });

  it('shows HTML and links as text, not as markup', () => {
    const table = toMarkdownTable(COLUMNS, [
      row({ text: '<img src=x onerror=alert(1)> [click](http://evil) `code`' }),
    ]);

    expect(table).not.toContain('<img');
    expect(table).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(table).toContain('\\[click\\](http://evil)');
    expect(table).toContain('\\`code\\`');
  });

  it('writes only the header and separator for no rows', () => {
    expect(toMarkdownTable(COLUMNS, []).split('\n')).toHaveLength(2);
  });
});
