// Reads, checks, adds and edits bgimage statements. No VS Code dependency.

import { addToTab, updateOptLists } from './elementEdits';
import { findElementStatements } from './elementLookup';
import { Section, insertIntoSection } from './frmSections';
import { LineEdit, Statement, Token, applyLineEdits, itemsOf, parseStatements, trailingCommentStart } from './frmStatements';

export const PLACEMENTS = ['FRAME', 'NOTFRAME', 'DIALOG'];
export const ALIGNMENTS = [
  'TOPLEFT', 'TOPMID', 'TOPRIGHT', 'MIDLEFT', 'MIDMID', 'MIDRIGHT', 'BOTTOMLEFT', 'BOTTOMMID', 'BOTTOMRIGHT', 'TILED'
];
const IMAGE_TYPE = /\.(bmp|jpe?g|tiff?|gif|png)$/i;
const MODE = /^\d+(\+\d+)*$/;

/** The values of a bgimage statement, in order. */
const PARTS = ['width', 'height', 'transparency', 'mode', 'placement', 'alignment', 'file'] as const;

/** Values of a background. Null is something other than a plain value, such as an expression. */
export interface BackgroundValues {
  /** Pixels; -1 stretches to the area, 0 is the picture's own size. */
  width: number | null;
  height: number | null;
  /** 0 is opaque, 255 invisible. */
  transparency: number | null;
  /** +64 alpha channel, +128 the top left pixel's colour is transparent. */
  mode: number | null;
  placement: string | null;
  alignment: string | null;
  /** File name or RGB(r,g,b), without quotes. */
  file: string | null;
}

export interface Background extends BackgroundValues { index?: number; }

/** Changed values of a background, as sent by the preview. */
export type BackgroundEdit = Partial<BackgroundValues>;

/** The value's tokens: strings and brace expressions are one token each. Stops at a comment. */
export function backgroundTokens(lines: string[], s: Statement): Token[] {
  const tokens: Token[] = [];
  if (s.valueStart < 0) return tokens;
  for (let line = s.startLine; line <= s.endLine; line++) {
    const content = lines[line].slice(0, trailingCommentStart(lines[line])).replace(/\s*\\\s*$/, '');
    const regex = /"[^"]*"|\{[^}]*\}|[^\s"{]+/g;
    regex.lastIndex = line === s.startLine ? s.valueStart : 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content))) {
      if (m[0].startsWith('!')) break;
      tokens.push({ line, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return tokens;
}

/** A token without quotes, or null for a brace expression that isn't just a string. */
function plain(text: string): string | null {
  if (!text.startsWith('{')) return text.replace(/^"|"$/g, '').trim();
  const m = text.match(/^\{\s*"([^"]*)"\s*\}$/);
  return m ? m[1].trim() : null;
}

function readValues(tokens: Token[]): BackgroundValues {
  const text = (n: number) => tokens[n] ? plain(tokens[n].text) : null;
  const num = (n: number) => {
    const v = text(n);
    return v !== null && /^-?\d+$/.test(v) ? Number(v) : null;
  };
  const oneOf = (n: number, among: string[]) => {
    const v = text(n)?.toUpperCase();
    return v !== undefined && among.includes(v) ? v : null;
  };
  const mode = text(3);
  // "a"+"b" is an expression
  const concatenated = tokens[7]?.text.startsWith('+') ?? false;
  return {
    width: num(0), height: num(1), transparency: num(2),
    mode: mode !== null && MODE.test(mode) ? mode.split('+').reduce((all, n) => all | Number(n), 0) : null,
    placement: oneOf(4, PLACEMENTS), alignment: oneOf(5, ALIGNMENTS),
    file: concatenated ? null : text(6) || null
  };
}

export function findBackgrounds(lines: string[]): Background[] {
  return itemsOf(parseStatements(lines), 'bgimage').map(s => ({ index: s.index, ...readValues(backgroundTokens(lines, s)) }));
}

/** Red, green and blue of an RGB(r,g,b) value. The numbers may be out of range. */
export function parseColor(file: string | null): [number, number, number] | undefined {
  const m = file?.match(/^RGB\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export const isTif = (file: string) => /\.tiff?$/i.test(file);

// ---- Where files are ----------------------------------------------------------------------------

/** The files a name in a form can stand for, best first. Bases are the custom and system folders. */
export function imageCandidates(fileName: string, bases: string[]): string[] {
  const name = fileName.trim().replace(/\\/g, '/');
  if (!name || name.startsWith('//')) return []; // a network share is never contacted because a form names it
  if (/^[a-z]:\//i.test(name)) return [name];
  const join = (...parts: string[]) => parts.map(p => p.replace(/\\/g, '/').replace(/\/+$/, '')).join('/');
  const dir = name.match(/^\$DIR_(\w+)\/+(.+)$/i);
  if (dir) return bases.map(base => join(base, dir[1].toLowerCase(), dir[2]));
  if (/^[$/]/.test(name)) return [];
  return bases.map(base => join(base, 'forms/images', name));
}

// ---- Problems -----------------------------------------------------------------------------------

export interface BackgroundProblem { severity: 'error' | 'warning' | 'info'; message: string; }

/** imageExists: whether a file name can be found; undefined when that isn't known. */
export function backgroundProblems(lines: string[], s: Statement, imageExists?: (file: string) => boolean | undefined): BackgroundProblem[] {
  const found: BackgroundProblem[] = [];
  const report = (severity: BackgroundProblem['severity'], message: string) => { found.push({ severity, message }); };
  const tokens = backgroundTokens(lines, s);
  if (tokens.length < PARTS.length) {
    report('error', `bgimage needs ${PARTS.join(', ')}; ${PARTS.slice(tokens.length).join(', ')} missing`);
    return found;
  }
  const v = readValues(tokens);
  PARTS.forEach((part, n) => {
    if (part === 'file' || v[part] !== null || plain(tokens[n].text) === null) return;
    const text = tokens[n].text;
    if (part === 'placement') report('error', `${text} is not a placement: use ${PLACEMENTS.join(', ')}`);
    else if (part === 'alignment') report('error', `${text} is not an alignment: use ${ALIGNMENTS.join(', ')}`);
    else report('error', `${part} must be a number, not ${text}`);
  });
  if (v.transparency !== null && (v.transparency < 0 || v.transparency > 255)) report('error', 'transparency must be 0 to 255');
  else if (v.transparency === 255) report('info', 'transparency 255 makes the background invisible');

  if (v.file === null) {
    if (tokens[6].text === '""') report('error', 'file name or RGB(red,green,blue) missing');
    return found;
  }
  const color = parseColor(v.file);
  if (color) {
    if (color.some(c => c > 255)) report('error', 'red, green and blue must be 0 to 255');
  } else if (/^RGB\s*\(/i.test(v.file)) {
    report('error', 'a colour is written RGB(red,green,blue)');
  } else if (/^RBG\s*\(/i.test(v.file)) {
    report('warning', 'a colour is written RGB(red,green,blue), not RBG');
  } else if (!IMAGE_TYPE.test(v.file)) {
    report('warning', 'file type not supported: use BMP, JPG, TIF, GIF or PNG');
  } else if (imageExists?.(v.file) === false) {
    report('warning', `${v.file} not found`);
  } else if (isTif(v.file)) {
    report('info', 'TIF files can not be shown in the preview');
  }
  return found;
}

// ---- Adding and editing -------------------------------------------------------------------------

/** A value as written in the file, or undefined when the preview sent something unusable. */
function written(part: typeof PARTS[number], value: unknown): string | undefined {
  switch (part) {
    case 'width': case 'height':
      return Number.isInteger(value) && (value as number) >= -1 ? String(value) : undefined;
    case 'transparency':
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255 ? String(value) : undefined;
    case 'mode': {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff) return undefined;
      const bits: number[] = [];
      for (let bit = 1; bit <= (value as number); bit *= 2) if ((value as number) & bit) bits.push(bit);
      return bits.join('+') || '0';
    }
    case 'placement': return PLACEMENTS.includes(value as string) ? value as string : undefined;
    case 'alignment': return ALIGNMENTS.includes(value as string) ? value as string : undefined;
    case 'file': {
      const name = typeof value === 'string' ? value.replace(/["{}\r\n]/g, '').replace(/\\+$/, '').trim() : '';
      return name ? `"${name}"` : undefined;
    }
  }
}

/** Insert a bgimage after the ones there are, otherwise where images end. */
export function insertBackground(lines: string[], statement: string[]): void {
  const last = itemsOf(parseStatements(lines), 'bgimage').pop();
  if (last) lines.splice(last.endLine + 1, 0, ...statement);
  else insertIntoSection(lines, Section.Image, statement);
}

/** Show a background on the given tabs only, or on all of them by naming it in no list. */
function setTabs(lines: string[], index: number, tabs: number[] | 'all'): void {
  const wanted = tabs === 'all' ? [] : tabs;
  const listed = new Set<number>();
  updateOptLists(lines, 'bgimage', (list, tabId) => {
    if (!list.includes(index)) return undefined;
    if (wanted.includes(tabId)) {
      listed.add(tabId);
      return undefined;
    }
    return list.filter(n => n !== index);
  });
  for (const tab of wanted) if (!listed.has(tab)) addToTab(lines, 'bgimage', index, tab);
}

export function validTabs(tabs: unknown): number[] | 'all' | undefined {
  if (tabs === 'all') return 'all';
  return Array.isArray(tabs) && tabs.length && tabs.every(t => Number.isInteger(t)) ? [...new Set(tabs as number[])] : undefined;
}

export function addBackground(source: string[], values: BackgroundEdit, tabs?: number[] | 'all'): { lines: string[]; key: string } | undefined {
  const parts = PARTS.map(part => written(part, values?.[part]));
  if (parts.includes(undefined)) return undefined;
  const lines = [...source];
  const index = findElementStatements(source).reduce((next, s) => s.type === 'bgimage' ? Math.max(next, s.index + 1) : next, 1);
  insertBackground(lines, [`bgimage(${index})= ${parts.join(' ')}`]);
  if (tabs && tabs !== 'all') setTabs(lines, index, tabs);
  return { lines, key: `bgimage:${index}` };
}

/** Change values of a background. Everything else, spacing and comments included, stays as written. */
export function editBackground(source: string[], index: number, edit: BackgroundEdit, tabs?: number[] | 'all'): string[] | undefined {
  const s = itemsOf(parseStatements(source), 'bgimage').find(b => b.index === index);
  if (!s) return undefined;
  const tokens = backgroundTokens(source, s);
  const edits: LineEdit[] = [];
  for (const [n, part] of PARTS.entries()) {
    if (edit?.[part] === undefined) continue;
    let text = written(part, edit[part]);
    const token = tokens[n];
    if (text === undefined || !token) return undefined;
    // {"name"} and "FRAME" keep their delimiters
    const wrap = token.text.match(/^(\{\s*")[^"]*("\s*\})$|^(")[^"]*(")$/);
    if (wrap) text = (wrap[1] ?? wrap[3]) + text.replace(/"/g, '') + (wrap[2] ?? wrap[4]);
    edits.push({ line: token.line, start: token.start, end: token.end, text });
  }
  const lines = applyLineEdits(source, edits);
  if (tabs) setTabs(lines, index, tabs);
  return lines;
}
