// Statements, index lists and the section order of an FRM file. No VS Code dependency.

import { lineContinues } from './elementLookup';

/** Join a statement starting at startIndex across `\` continuations. */
export function collectContinuedStatement(lines: string[], startIndex: number): { text: string; endIndex: number } {
  let i = startIndex;
  const parts: string[] = [];
  while (i < lines.length) {
    let content = lines[i];
    const cont = lineContinues(content);
    if (cont) {
      content = content.trimEnd().slice(0, -1);
    }
    parts.push(i === startIndex ? content : content.trim());
    if (!cont) break;
    i++;
  }
  return { text: parts.join(' '), endIndex: i };
}

/** Text after the first `=` in a joined statement. */
export function statementValue(joinedText: string): string {
  const eq = joinedText.indexOf('=');
  return eq >= 0 ? joinedText.slice(eq + 1) : joinedText;
}

/** Keyword part of a statement line, e.g. `opt_text(1)` or `group(1)`. */
export function statementKeyword(line: string): string {
  const m = line.match(/^\s*([^=]+?)\s*=/);
  return m ? m[1].trim() : line.trim();
}

/** Parse a list of numeric indexes, ignoring leftover `\` tokens. */
export function parseIndexList(raw: string): number[] {
  return raw
    .replace(/\\/g, ' ')
    .replace(/[,;]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(n => Number.isFinite(n));
}

/** Items-per-line from the first line of a wrapped statement. */
export function wrapWidthFromFirstLine(firstLine: string): number {
  const afterEq = firstLine.includes('=') ? firstLine.slice(firstLine.indexOf('=') + 1) : firstLine;
  const content = afterEq.replace(/\\\s*$/, '').trim();
  const count = content ? content.split(/\s+/).filter(Boolean).length : 0;
  return count > 0 ? count : 10;
}

/**
 * Rebuild a `keyword= items` statement. If wrapAt is set, wrap with trailing `\`
 * and 16-space indent on continuation lines (same style as existing group rewriter).
 */
export function formatIndexStatement(keywordWithArgs: string, items: Array<string | number>, wrapAt?: number): string[] {
  const toks = items.map(String);
  if (toks.length === 0) {
    return [`${keywordWithArgs}=`];
  }
  const shouldWrap = wrapAt != null && wrapAt > 0;
  if (!shouldWrap) {
    return [`${keywordWithArgs}= ${toks.join(' ')}`];
  }
  const out: string[] = [];
  let current: string[] = [];
  for (let idx = 0; idx < toks.length; idx++) {
    current.push(toks[idx]);
    if (current.length >= wrapAt && idx < toks.length - 1) {
      const body = current.join(' ');
      out.push(out.length === 0 ? `${keywordWithArgs}= ${body}\\` : `                ${body}\\`);
      current = [];
    }
  }
  if (current.length > 0) {
    const body = current.join(' ');
    out.push(out.length === 0 ? `${keywordWithArgs}= ${body}` : `                ${body}`);
  }
  return out;
}

export function replaceContinuedStatement(lines: string[], startIndex: number, newLines: string[]): void {
  const { endIndex } = collectContinuedStatement(lines, startIndex);
  lines.splice(startIndex, endIndex - startIndex + 1, ...newLines);
}

// ---------------------------------------------------------------------------
// File section order
// ---------------------------------------------------------------------------

/** Sections of an FRM file, in the order they should appear. */
export const enum Section {
  Charset = 0,
  Header = 1,
  Text = 2,
  Field = 3,
  Group = 4,
  Button = 5,
  Image = 6,
  Preview = 7,
  Opt = 8,
  TabOrder = 9,
  Trigger = 10,
}

const HEADER_KEYWORDS = new Set(['vxdbase_winstyle', 'port_size', 'revision', 'status_bar', 'header', 'page_header']);
const OPT_KIND_ORDER = ['text', 'field', 'pushbutton', 'image', 'preview'];

export interface StatementClass {
  section: Section;
  /** `(n)` index of the statement, if any. */
  index?: number;
  /** Secondary sort key inside the section (used for opt_* kinds). */
  kind?: number;
}

export function isBlankLine(line: string): boolean {
  return /^\s*$/.test(line);
}

export function isCommentLine(line: string): boolean {
  return /^\s*!/.test(line);
}

/** A lone `!` used to separate sections. */
export function isSeparatorLine(line: string): boolean {
  return isBlankLine(line) || /^\s*!\s*$/.test(line);
}

/** Which section a statement line belongs to, or undefined for unrecognised statements. */
export function classifyStatement(line: string): StatementClass | undefined {
  const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\(\s*(\d+)\s*\))?\s*=/);
  if (!m) {
    return undefined;
  }
  const keyword = m[1].toLowerCase();
  const index = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
  if (keyword === 'charset') return { section: Section.Charset };
  if (HEADER_KEYWORDS.has(keyword)) return { section: Section.Header };
  switch (keyword) {
    case 'text': return { section: Section.Text, index };
    case 'field': return { section: Section.Field, index };
    case 'group': return { section: Section.Group, index };
    case 'button':
    case 'pushbutton': return { section: Section.Button, index };
    case 'image': return { section: Section.Image, index };
    case 'preview': return { section: Section.Preview, index };
    case 'tab_order': return { section: Section.TabOrder };
    case 'trigger': return { section: Section.Trigger };
  }
  if (keyword.startsWith('opt_')) {
    const kindName = keyword.slice(4) === 'button' ? 'pushbutton' : keyword.slice(4);
    const kind = OPT_KIND_ORDER.indexOf(kindName);
    return { section: Section.Opt, index, kind: kind >= 0 ? kind : OPT_KIND_ORDER.length };
  }
  return undefined;
}

/** Number of leading lines forming the top-of-file comment banner (comments and blanks before the first statement). */
export function bannerLength(lines: string[]): number {
  let i = 0;
  while (i < lines.length && (isBlankLine(lines[i]) || isCommentLine(lines[i]))) {
    i++;
  }
  return i;
}

/**
 * Insert new statement lines where their section belongs:
 * after the last statement of the same section, otherwise between the
 * neighbouring sections, separated from them by an empty line.
 * Unrecognised statements count as part of the section of the statement above them.
 */
export function insertIntoSection(lines: string[], section: Section, newLines: string[]): void {
  let lastSameEnd = -1;
  let lastLowerEnd = -1;
  let firstHigherStart = -1;
  let current: Section = Section.Header;

  for (let i = bannerLength(lines); i < lines.length; i++) {
    if (isBlankLine(lines[i]) || isCommentLine(lines[i])) {
      continue;
    }
    const end = collectContinuedStatement(lines, i).endIndex;
    const cls = classifyStatement(lines[i]);
    if (cls) {
      current = cls.section;
    }
    if (current === section) {
      lastSameEnd = end;
    } else if (current < section) {
      lastLowerEnd = end;
    } else if (firstHigherStart < 0) {
      firstHigherStart = i;
    }
    i = end;
  }

  if (lastSameEnd >= 0) {
    lines.splice(lastSameEnd + 1, 0, ...newLines);
    return;
  }

  if (lastLowerEnd >= 0) {
    const at = lastLowerEnd + 1;
    const block = ['', ...newLines];
    if (at < lines.length && !isSeparatorLine(lines[at])) {
      block.push('');
    }
    lines.splice(at, 0, ...block);
    return;
  }

  if (firstHigherStart >= 0) {
    // Go above comments attached to the next statement, unless they are the top banner.
    let at = firstHigherStart;
    while (at > 0 && isCommentLine(lines[at - 1]) && !isSeparatorLine(lines[at - 1])) {
      at--;
    }
    if (at <= bannerLength(lines) && lines.slice(0, at).every(l => isBlankLine(l) || isCommentLine(l))) {
      at = firstHigherStart;
    }
    lines.splice(at, 0, ...newLines, '');
    return;
  }

  // No statements at all: append at the end of the file (before a final newline).
  let at = lines.length;
  if (at > 0 && lines[at - 1] === '') {
    at--;
  }
  const block = at > 0 && !isBlankLine(lines[at - 1]) ? ['', ...newLines] : [...newLines];
  lines.splice(at, 0, ...block);
}
