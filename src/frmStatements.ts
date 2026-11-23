// Splits an FRM file into statements and number tokens. No VS Code dependency.
import { lineContinues } from './elementLookup';

/** Element kinds that carry an index. `button` covers both `button` and `pushbutton`. */
export type ItemKind = 'text' | 'field' | 'button' | 'image' | 'bgimage' | 'preview';

export interface Statement {
  /** Lower-case keyword, e.g. `field` or `opt_text`. */
  keyword: string;
  index?: number;
  startLine: number;
  /** Last line, including `\` continuations. */
  endLine: number;
  /** Columns of the keyword on the first line. */
  keywordStart: number;
  keywordEnd: number;
  /** Columns of the `(n)` part on the first line, parentheses included. Empty (start = end) when there is none. */
  indexStart: number;
  indexEnd: number;
  /** Column just after `=` on the first line, or -1 when there is no `=`. */
  valueStart: number;
}

export interface Token {
  line: number;
  start: number;
  end: number;
  text: string;
}

const STATEMENT = /^(\s*)([A-Za-z_$][\w$]*)(\s*)(\(\s*(\d*)\s*\))?\s*(=)?/;

/** Every statement in file order. Comment and blank lines are not statements. */
export function parseStatements(lines: string[]): Statement[] {
  const found: Statement[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(!|$)/.test(lines[i])) continue;
    const startLine = i;
    while (i < lines.length - 1 && lineContinues(lines[i])) i++;
    const m = lines[startLine].match(STATEMENT);
    if (!m) continue;
    const keywordStart = m[1].length;
    const keywordEnd = keywordStart + m[2].length;
    const indexStart = m[4] !== undefined ? keywordEnd + m[3].length : keywordEnd;
    found.push({
      keyword: m[2].toLowerCase(),
      index: m[5] ? Number(m[5]) : undefined,
      startLine,
      endLine: i,
      keywordStart,
      keywordEnd,
      indexStart,
      indexEnd: indexStart + (m[4]?.length ?? 0),
      valueStart: m[6] ? m[0].length : -1,
    });
  }
  return found;
}

export function itemKind(keyword: string): ItemKind | undefined {
  switch (keyword) {
    case 'pushbutton': return 'button';
    case 'text': case 'field': case 'button': case 'image': case 'bgimage': case 'preview': return keyword;
  }
  return undefined;
}

/** Item statements: a kind's keyword followed by `=`. */
export function itemsOf(statements: Statement[], kind: ItemKind): Statement[] {
  return statements.filter(s => s.valueStart >= 0 && itemKind(s.keyword) === kind);
}

/** The kind an `opt_*` list refers to. */
export function optListKind(keyword: string): ItemKind | undefined {
  return keyword.startsWith('opt_') ? itemKind(keyword.slice(4)) : undefined;
}

/** Column where a `;!` comment starts (outside double quotes), or the line's length. */
export function trailingCommentStart(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === ';' && /^;\s*!/.test(line.slice(i))) return i;
  }
  return line.length;
}

/** The first line's text after `=`, without a trailing comment. */
export function firstLineValue(lines: string[], s: Statement): string {
  const line = lines[s.startLine];
  return s.valueStart < 0 ? '' : line.slice(s.valueStart, Math.max(s.valueStart, trailingCommentStart(line)));
}

/** Value tokens of a list statement (index lists, group, trigger), across continuations and without comments. */
export function listTokens(lines: string[], s: Statement): Token[] {
  const tokens: Token[] = [];
  if (s.valueStart < 0) return tokens;
  for (let line = s.startLine; line <= s.endLine; line++) {
    const from = line === s.startLine ? s.valueStart : 0;
    const bang = lines[line].indexOf('!', from);
    const content = bang < 0 ? lines[line] : lines[line].slice(0, bang);
    const regex = /[^\s,;\\]+/g;
    regex.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content))) {
      tokens.push({ line, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return tokens;
}

function isIndex(token: Token): boolean {
  return /^\d+$/.test(token.text);
}

/** How many values come before the field numbers in a `group` statement: 3 with `revision= 2`, otherwise 2. */
export function groupFixedValues(lines: string[], statements: Statement[]): number {
  const revision = statements.find(s => s.keyword === 'revision' && s.valueStart >= 0);
  return revision && /^\s*2\b/.test(firstLineValue(lines, revision)) ? 3 : 2;
}

/** The tokens of a statement that are indexes of items of the given kind. */
export function referenceTokens(lines: string[], s: Statement, kind: ItemKind, groupFixed: number): Token[] {
  if (optListKind(s.keyword) === kind) return listTokens(lines, s).filter(isIndex);
  if (kind !== 'field') return [];
  switch (s.keyword) {
    case 'group': return listTokens(lines, s).slice(groupFixed).filter(isIndex);
    case 'tab_order': return listTokens(lines, s).filter(isIndex);
    case 'trigger': return listTokens(lines, s).slice(0, 1).filter(isIndex);
  }
  return [];
}

/** Row and column of an item, when written as plain numbers. */
export function itemPosition(lines: string[], s: Statement): { row: number; col: number } | undefined {
  const value = firstLineValue(lines, s);
  const m = itemKind(s.keyword) === 'field'
    ? value.match(/^\s*(?:"[^"]*"|<[^>]*>|\S+)\s+\S+\s+(\d+)\s+(\d+)/)
    : value.match(/^\s*(\d+)\s+(\d+)/);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : undefined;
}

/** Which spellings of button statements and lists the form uses. */
export function buttonSpellings(statements: Statement[]): { button: boolean; pushbutton: boolean; mixed: boolean } {
  const uses = (name: string) => statements.some(s => s.valueStart >= 0 && (s.keyword === name || s.keyword === `opt_${name}`));
  const button = uses('button');
  const pushbutton = uses('pushbutton');
  return { button, pushbutton, mixed: button && pushbutton };
}

/** The spelling new buttons get: `button`, unless the form only uses `pushbutton`. */
export function newButtonKeyword(lines: string[]): 'button' | 'pushbutton' {
  const s = buttonSpellings(parseStatements(lines));
  return s.pushbutton && !s.button ? 'pushbutton' : 'button';
}

export interface LineEdit {
  line: number;
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits given in original coordinates. Returns new lines. */
export function applyLineEdits(lines: string[], edits: LineEdit[]): string[] {
  const out = [...lines];
  for (const e of [...edits].sort((a, b) => b.line - a.line || b.start - a.start)) {
    out[e.line] = out[e.line].slice(0, e.start) + e.text + out[e.line].slice(e.end);
  }
  return out;
}
