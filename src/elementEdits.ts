// Adds, moves, deletes and duplicates form elements in the lines of an FRM file. No VS Code dependency.

import { insertBackground } from './backgrounds';
import { findElement, findElementStatements } from './elementLookup';
import {
  Section, collectContinuedStatement, formatIndexStatement, insertIntoSection, parseIndexList,
  replaceContinuedStatement, statementKeyword, statementValue, wrapWidthFromFirstLine
} from './frmSections';
import { newButtonKeyword } from './frmStatements';

export interface ElementRef { type: string; index: number; }

/** An element and the position it gets. */
export interface ElementMove extends ElementRef { row: number; col: number; }

/** An element and the row its copy gets; the column stays. */
export interface ElementCopy extends ElementRef { row: number; }

export const SECTION_OF: Record<string, Section> = {
  text: Section.Text,
  field: Section.Field,
  pushbutton: Section.Button,
  image: Section.Image,
  bgimage: Section.Image, // see insertBackground
  preview: Section.Preview,
};

const isInt = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

/** Elements that can be moved, stretched and deleted, but not added, copied or duplicated (page_listview). */
export const PLACE_ONLY_TYPES = ['listview'];

/**
 * The elements of a message from the preview, each once; anything malformed is left out.
 * placeOnly: also accept PLACE_ONLY_TYPES (moves and deletes).
 */
export function validRefs<T extends ElementRef>(items: unknown, isValid: (item: T) => boolean = () => true, placeOnly = false): T[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const types = [...Object.keys(SECTION_OF), ...(placeOnly ? PLACE_ONLY_TYPES : [])];
  return (items as T[]).filter(item => {
    if (!item || !types.includes(item.type) || !isInt(item.index, 0) || !isValid(item)) return false;
    const key = keyOf(item);
    return !seen.has(key) && !!seen.add(key);
  });
}

export const isMove = (m: ElementMove) => isInt(m.row, 1) && isInt(m.col, 1);
export const isCopy = (c: ElementCopy) => isInt(c.row, 1);

export function keyOf(ref: ElementRef): string {
  return `${ref.type}:${ref.index}`;
}

export function revisionOf(lines: string[]): number | undefined {
  for (const line of lines) {
    const m = line.match(/^\s*revision\s*=\s*(\d+)/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** The text up to the row number of an element's statement (1), the row (2), the space (3) and the column (4). */
export function matchPosition(line: string, type: string): RegExpMatchArray | null {
  if (type === 'bgimage') return null; // starts with its size
  // field(n)= NAME type row col ...; NAME is plain, quoted or in angle brackets. The others start with row col.
  return line.match(type === 'field'
    ? /^(\s*field\s*\(\s*\d+\s*\)\s*=\s*(?:"[^"]+"|<[^>]+>|[\w$]+)\s+[\d+]+\s+)(\d+)(\s+)(\d+)/i
    : /^(\s*\w+\s*\(\s*\d+\s*\)\s*=\s*)(\d+)(\s+)(\d+)/);
}

/** Give elements new positions. Only their row and column numbers change. */
export function moveElements(source: string[], moves: ElementMove[]): { lines: string[]; failed: ElementRef[] } {
  const lines = [...source];
  const failed: ElementRef[] = [];
  for (const move of moves) {
    const statement = findElement(lines, move.type, move.index);
    const m = statement && matchPosition(lines[statement.startLine], move.type);
    if (!statement || !m) {
      failed.push(move);
      continue;
    }
    if (Number(m[2]) === move.row && Number(m[4]) === move.col) continue;
    lines[statement.startLine] = `${m[1]}${move.row} ${move.col}${lines[statement.startLine].slice(m[0].length)}`;
  }
  return { lines, failed };
}

/** Change the index list of every opt_* statement of an element type. Lists that become empty are removed. */
export function updateOptLists(lines: string[], type: string, change: (list: number[], tabId: number) => number[] | undefined): void {
  // opt_button is a synonym for opt_pushbutton
  const typeName = type === 'pushbutton' ? '(?:pushbutton|button)' : type;
  const pattern = new RegExp(`^\\s*opt_${typeName}\\s*\\(\\s*(\\d+)\\s*\\)\\s*=`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(pattern);
    if (!m) continue;
    const collected = collectContinuedStatement(lines, i);
    const list = change(parseIndexList(statementValue(collected.text)), Number(m[1]));
    if (!list) continue;
    const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
    const newLines = list.length ? formatIndexStatement(statementKeyword(lines[i]), list, wrapAt) : [];
    lines.splice(i, collected.endIndex - i + 1, ...newLines);
    i += newLines.length - 1;
  }
}

/** Add a field index to group(1), keeping the leading non-index values (type_expr val1, and val2 for revision 2). */
export function addFieldToGroup1(lines: string[], fieldIndex: number, revision: number | undefined): void {
  const groupRegex = /^\s*group\s*\(\s*1\s*\)\s*=\s*/i;
  const i = lines.findIndex(l => groupRegex.test(l));
  if (i < 0) return;
  const collected = collectContinuedStatement(lines, i);
  const items = statementValue(collected.text).replace(/\\/g, ' ').trim().split(/\s+/).filter(Boolean);
  const preserveCount = revision === 2 ? 3 : 2;
  const preserved = items.slice(0, preserveCount);
  const fieldIndexes = items.slice(preserveCount).map(s => parseInt(s)).filter(n => !isNaN(n));
  if (fieldIndexes.includes(fieldIndex)) return;
  fieldIndexes.push(fieldIndex);
  fieldIndexes.sort((a, b) => a - b);
  const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
  replaceContinuedStatement(lines, i, formatIndexStatement('group(1)', [...preserved, ...fieldIndexes], wrapAt));
}

function removeFieldsFromGroup1(lines: string[], indexes: Set<number>): void {
  const i = lines.findIndex(l => /^\s*group\s*\(\s*1\s*\)\s*=\s*/i.test(l));
  if (i < 0) return;
  const collected = collectContinuedStatement(lines, i);
  // group(1)= type_expr val1 [val2, revision 2 only] field indexes
  const items = statementValue(collected.text).replace(/\\/g, ' ').split(/[,;\s]+/).filter(Boolean);
  const preserveCount = revisionOf(lines) === 2 ? 3 : 2;
  const members = items.slice(preserveCount).map(Number).filter(n => !isNaN(n) && !indexes.has(n));
  const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
  replaceContinuedStatement(lines, i, formatIndexStatement('group(1)', [...items.slice(0, preserveCount), ...members], wrapAt));
}

/** Remove elements, and their indexes from group(1) (fields) and the tabs' opt_* lists. */
export function deleteElements(source: string[], refs: ElementRef[]): { lines: string[]; deleted: ElementRef[] } {
  const lines = [...source];
  const deleted = refs.filter(ref => {
    const statement = findElement(lines, ref.type, ref.index);
    if (statement) lines.splice(statement.startLine, statement.endLine - statement.startLine + 1);
    return !!statement;
  });
  for (const type of new Set(deleted.map(ref => ref.type))) {
    const indexes = new Set(deleted.filter(ref => ref.type === type).map(ref => ref.index));
    if (type === 'field') removeFieldsFromGroup1(lines, indexes);
    updateOptLists(lines, type, list => {
      const rest = list.filter(n => !indexes.has(n));
      return rest.length === list.length ? undefined : rest;
    });
  }
  return { lines, deleted };
}

/**
 * Copy elements' statements verbatim under the next free indexes, at the given rows, visible on the
 * same tabs as the originals. `copies` maps each original's key to its copy's, in file order.
 */
export function duplicateElements(source: string[], items: ElementCopy[]): { lines: string[]; copies: Map<string, string>; failed: ElementRef[] } {
  const lines = [...source];
  const copies = new Map<string, string>();
  const statements = findElementStatements(source);
  const revision = revisionOf(source);
  const nextIndex: Record<string, number> = {};
  for (const s of statements) nextIndex[s.type] = Math.max(nextIndex[s.type] ?? 1, s.index + 1);

  const wanted = new Map(items.map(item => [keyOf(item), item]));
  for (const s of statements) {
    const item = wanted.get(keyOf(s));
    if (!item) continue;
    const statement = source.slice(s.startLine, s.endLine + 1);
    // The row is the first number after '=', except for fields: field(n)= NAME type row col ...
    const m = statement[0].match(s.type === 'bgimage' ? /^(\s*\w+\s*\(\s*)\d+(\s*\)\s*=\s*)/ : s.type === 'field'
      ? /^(\s*\w+\s*\(\s*)\d+(\s*\)\s*=\s*(?:"[^"]+"|\S+)\s+\S+\s+)\d+/
      : /^(\s*\w+\s*\(\s*)\d+(\s*\)\s*=\s*)\d+/);
    if (!m) continue;
    wanted.delete(keyOf(s)); // the first definition only, if an index is used twice
    const index = nextIndex[s.type]++;
    statement[0] = m[1] + index + m[2] + (s.type === 'bgimage' ? '' : item.row) + statement[0].slice(m[0].length);
    if (s.type === 'bgimage') insertBackground(lines, statement);
    else insertIntoSection(lines, SECTION_OF[s.type], statement);
    if (s.type === 'field') addFieldToGroup1(lines, index, revision);
    updateOptLists(lines, s.type, list =>
      list.includes(s.index) && !list.includes(index) ? [...list, index].sort((a, b) => a - b) : undefined);
    copies.set(keyOf(item), `${s.type}:${index}`);
  }
  return { lines, copies, failed: [...wanted.values()] };
}

/** What the add/edit dialogs send; which of the optional values are present depends on the element type. */
export interface ElementContent {
  elementType: string;
  row: number;
  col: number;
  // text
  content?: string;
  boxRows?: number | null;
  boxCols?: number | null;
  // field
  name?: string;
  nameFormat?: { angle?: boolean; quoted?: boolean };
  type?: string;
  len?: number;
  ignore?: number | string | null;
  values?: string[];
  // pushbutton (also uses name)
  label?: string;
  kind?: string;
  program?: string;
  value?: string;
  // preview and image
  rows?: number;
  cols?: number;
  mode?: string;
  // preview
  path?: string;
  field?: string;
  portType?: string;
  portStyle?: string;
  // image
  file?: string;
}

/** A new element; on a form with tabs it is added to the active one. */
export interface NewElement extends ElementContent { activeTabId?: number | null; }

const IMAGE_MODE = /^\d+(\+\d+)*$/;

/** An image file name that can stand in quotes or braces on one line. */
function imageFileName(file: unknown): string {
  return typeof file === 'string' ? file.replace(/["{}\r\n]/g, '').replace(/\\+$/, '').trim() : '';
}

/** The statement of a new element, or undefined when the message makes no sense. */
function elementLine(lines: string[], index: number, msg: ElementContent, winstyle?: string): string | undefined {
  const at = `${msg.row} ${msg.col}`;
  switch (msg.elementType) {
    case 'text': {
      const content = msg.content || '';
      return msg.boxRows && msg.boxCols
        ? `text(${index})= ${at} {"${content}"+" #[${msg.boxRows},${msg.boxCols}]*"}`
        : `text(${index})= ${at} "${content}"`;
    }
    case 'field': {
      const name = msg.name || `FIELD${index}`;
      // Default ignore value: 7 for VXUI, 4 for only
      const ignore = msg.ignore !== undefined && msg.ignore !== null && msg.ignore !== '' ? msg.ignore
        : winstyle?.toLowerCase() === 'only' ? 4 : 7;
      const values = (msg.values || []).map(v => ` "${v}"`).join('');
      const angled = msg.nameFormat?.angle ? `<${name}>` : name;
      const formatted = msg.nameFormat?.quoted ? `"${angled}"` : angled;
      return `field(${index})= ${formatted} ${msg.type || '1'} ${at} ${msg.len || 10} ${ignore}${values}`;
    }
    case 'pushbutton': {
      const start = `${newButtonKeyword(lines)}(${index})= ${at} "${msg.label || ''}"`;
      if (msg.kind === 'checkbox') return `${start} CHECKBOX ${msg.name || 'VAR'}=${msg.value || '1;0'}`;
      if (msg.kind === 'radio') return `${start} RADIO ${msg.name || 'VAR'}=${msg.value ?? '1;0'}`;
      if (msg.program) return `${start} ${msg.program.startsWith('@') ? '' : '@'}${msg.program} P`;
      if (msg.name) return `${start} ${msg.name}=${msg.value ?? '1'}`;
      return start;
    }
    case 'image': {
      // Without a file the Properties panel asks for one
      const mode = msg.mode && IMAGE_MODE.test(msg.mode) ? msg.mode : '0';
      return `image(${index})= ${at} ${msg.rows || 10} ${msg.cols || 20} ${mode} "${imageFileName(msg.file)}"`;
    }
    case 'preview': {
      const portStyle = msg.portStyle ?? 'SIMPLE';
      return `preview(${index})= ${at} ${msg.rows || 10} ${msg.cols || 30} ${msg.mode || '0'} ` +
        `"${(msg.path ?? '').replace(/"/g, '')}" "${msg.field || ''}" ${msg.portType || 'PORT_2D'} ${portStyle === '' ? '""' : portStyle}`;
    }
  }
  return undefined;
}

/** Add an element under the next free index, in its section, in group(1) (fields) and on the active tab. */
export function addElement(source: string[], msg: NewElement, winstyle?: string): { lines: string[]; key: string } | undefined {
  const type = msg.elementType;
  if (!Object.keys(SECTION_OF).includes(type) || type === 'bgimage' || !isInt(msg.row, 1) || !isInt(msg.col, 1)) return undefined;
  const lines = [...source];
  const index = findElementStatements(source).reduce((next, s) => s.type === type ? Math.max(next, s.index + 1) : next, 1);
  const line = elementLine(lines, index, msg, winstyle);
  if (!line) return undefined;
  insertIntoSection(lines, SECTION_OF[type], [line]);
  if (type === 'field') addFieldToGroup1(lines, index, revisionOf(source));
  if (msg.activeTabId !== undefined && msg.activeTabId !== null) addToTab(lines, type, index, msg.activeTabId);
  return { lines, key: keyOf({ type, index }) };
}

/** Add an element to a tab's opt_* list, which is created when the tab has none of that type. */
export function addToTab(lines: string[], type: string, index: number, tabId: number): void {
  // An existing list is used whichever way it spells opt_button
  const typeName = type === 'pushbutton' ? '(?:push)?button' : type;
  const pattern = new RegExp(`^\\s*opt_${typeName}\\s*\\(\\s*${tabId}\\s*\\)\\s*=`, 'i');
  const i = lines.findIndex(l => pattern.test(l));
  if (i < 0) {
    const name = type === 'pushbutton' ? newButtonKeyword(lines) : type;
    insertIntoSection(lines, Section.Opt, [`opt_${name}(${tabId})= ${index}`]);
    return;
  }
  const collected = collectContinuedStatement(lines, i);
  const list = [...parseIndexList(statementValue(collected.text)), index].sort((a, b) => a - b);
  const wrapAt = collected.endIndex > i ? wrapWidthFromFirstLine(lines[i]) : undefined;
  replaceContinuedStatement(lines, i, formatIndexStatement(statementKeyword(lines[i]), list, wrapAt));
}

