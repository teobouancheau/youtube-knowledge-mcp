/**
 * Writing rows out as CSV and Markdown tables.
 *
 * Exported comments are text written by strangers, and a spreadsheet will run a cell
 * that begins like a formula. Every text field is therefore defused on the way out,
 * as OWASP's CSV-injection guidance prescribes, rather than trusted because it came
 * from a platform.
 */

export type Cell = string | number | boolean | null | undefined;

export interface Column<T> {
  header: string;
  value: (row: T) => Cell;
  /**
   * Written as it is, never defused. For identifiers, which are validated elsewhere and
   * must come back exact: a YouTube id may begin with `-`, and a leading apostrophe
   * would make it a different id.
   */
  verbatim?: boolean;
}

/** Characters that make a spreadsheet read a cell as a formula (or as a command). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function defused(text: string): string {
  const first = text[0];
  return first !== undefined && FORMULA_TRIGGERS.has(first) ? `'${text}` : text;
}

function csvField(cell: Cell, verbatim = false): string {
  if (cell === null || cell === undefined) return '';
  // Numbers and booleans are not text: a negative number is data, not a formula.
  if (typeof cell !== 'string') return String(cell);

  const text = verbatim ? cell : defused(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180: a header row, CRLF line endings, every record ended with one. */
export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const header = columns.map((column) => csvField(column.header)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => csvField(column.value(row), column.verbatim)).join(',')
  );
  return [header, ...body].map((line) => `${line}\r\n`).join('');
}

/** Characters that carry meaning in Markdown or HTML, and so must not be left to the reader's renderer. */
const MARKDOWN_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '|': '\\|',
  '`': '\\`',
  '[': '\\[',
  ']': '\\]',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * One table cell. Comment text is written by strangers and may hold HTML or links; it is
 * shown as text, never as markup, and cannot end its cell or its row.
 */
function markdownCell(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell)
    .replace(/[\\|`[\]<>]/g, (character) => MARKDOWN_ESCAPES[character] ?? character)
    .replace(/\r\n|\r|\n/g, ' ');
}

export function toMarkdownTable<T>(columns: Column<T>[], rows: T[]): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;

  return [
    line(columns.map((column) => markdownCell(column.header))),
    line(columns.map(() => '---')),
    ...rows.map((row) => line(columns.map((column) => markdownCell(column.value(row))))),
  ].join('\n');
}
