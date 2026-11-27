// The Properties panel's view of form elements: every property as written, and changes to one property
// at a time that rewrite only its own token. No VS Code dependency.

import { ALIGNMENTS, PLACEMENTS, editBackground, findBackgrounds } from './backgrounds';
import { parseButtonAssignment } from './buttonAssignment';
import { ElementRef, addToTab, keyOf, updateOptLists } from './elementEdits';
import { Section, collectContinuedStatement, formatIndexStatement, insertIntoSection, statementKeyword, wrapWidthFromFirstLine } from './frmSections';
import { Statement, Token, groupFixedValues, itemKind, listTokens, optListKind, parseStatements, valueTokens } from './frmStatements';

// ---- What the panel shows -------------------------------------------------------------------------

export interface PropDef {
  key: string;
  label: string;
  /**
   * int: a whole number. text: one line. lines: one value per line. check: '1' or ''. select: one of options.
   * flags: bits added up (changed with setElementFlag). tabs: 'all' or tab ids. range: int slider.
   * bgsize: -1 stretch, 0 own size, else pixels. bgfile: a picture's file name or RGB(r,g,b).
   * image: an image file name, picked from the images folder.
   */
  kind: 'int' | 'text' | 'lines' | 'check' | 'select' | 'flags' | 'tabs' | 'range' | 'bgsize' | 'bgfile' | 'image';
  min?: number;
  max?: number;
  /** An int that may be left empty. */
  optional?: boolean;
  /** Regex source a text must match as a whole. */
  pattern?: string;
  options?: Array<{ value: string; label: string }>;
  bits?: Array<{ bit: number; label: string }>;
  hint?: string;
  /** Shown only while that property has one of these values. */
  when?: { key: string; values: string[] };
  /** Sits next to the property before it. */
  pair?: boolean;
  /** Suggestions for a text: field names. */
  suggest?: 'fields';
}

const NAME = '^\\$?[A-Za-z0-9_]+$';
const row = (label = 'Row'): PropDef => ({ key: 'row', label, kind: 'int', min: 1 });
const col = (label = 'Column'): PropDef => ({ key: 'col', label, kind: 'int', min: 1, pair: true });
const size = (rowsLabel = 'Rows', colsLabel = 'Columns'): PropDef[] => [
  { key: 'rows', label: rowsLabel, kind: 'int', min: 1 },
  { key: 'cols', label: colsLabel, kind: 'int', min: 1, pair: true }
];
const tabs: PropDef = { key: 'tabs', label: 'Tabs', kind: 'tabs' };
const STRETCH_BITS = [{ bit: 1, label: 'No horizontal stretch' }, { bit: 2, label: 'No vertical stretch' }];
const TRANSPARENT_BITS = [{ bit: 64, label: 'Transparent by alpha channel' }, { bit: 128, label: 'Transparent by top left corner\'s colour' }];
const unknown = (bit: number) => ({ bit, label: 'Unknown value' });

export const PROP_DEFS: Record<string, PropDef[]> = {
  text: [
    { key: 'content', label: 'Text', kind: 'text', hint: 'Plain text, or an {EXPRESSION} in braces' },
    row(), col(),
    { key: 'boxRows', label: 'Box rows', kind: 'int', min: 1, optional: true },
    { key: 'boxCols', label: 'Box columns', kind: 'int', min: 1, optional: true, pair: true },
    tabs
  ],
  field: [
    { key: 'name', label: 'Name', kind: 'text', pattern: NAME, hint: 'Letters, digits and _, optionally starting with $' },
    { key: 'nameAngle', label: 'Angle brackets <>', kind: 'check' },
    { key: 'nameQuoted', label: 'Quoted ""', kind: 'check', pair: true },
    {
      key: 'type', label: 'Type', kind: 'flags', bits: [
        { bit: 1, label: 'Active field' }, { bit: 2, label: 'No free-text field' }, { bit: 4, label: 'Locked field' },
        { bit: 8, label: 'Must assign a value before closing' }, ...[16, 32, 64, 128, 256, 512, 1024, 2048].map(unknown),
        { bit: 4096, label: 'EXO field' }, { bit: 8192, label: 'Transparent field' }, { bit: 16384, label: 'Right align' },
        { bit: 32768, label: 'Center align' }
      ]
    },
    row(), col(),
    { key: 'len', label: 'Length', kind: 'text', pattern: '^[1-9]\\d*(\\.\\d+|\\|\\d+)?$', hint: 'Columns; 10.2 with decimals, 30|3 with lines' },
    { key: 'ignore', label: 'Ignore value', kind: 'text', pattern: '^-?\\d+$', hint: 'Usually 7' },
    {
      key: 'values', label: 'Dropdown values', kind: 'lines',
      hint: 'One per line. "Description [value]*" shows a description; "path:name" reads the values from forms/fieldvalues'
    },
    { key: 'group', label: 'Group', kind: 'int', min: 1 },
    tabs
  ],
  pushbutton: [
    { key: 'label', label: 'Label', kind: 'text', hint: 'Plain text, or an {EXPRESSION} in braces' },
    {
      key: 'kind', label: 'Kind', kind: 'select',
      options: [{ value: 'select', label: 'Button' }, { value: 'checkbox', label: 'Checkbox' }, { value: 'radio', label: 'Radio button' }]
    },
    {
      key: 'action', label: 'Action', kind: 'select', when: { key: 'kind', values: ['select'] },
      options: [{ value: 'none', label: 'None' }, { value: 'program', label: 'Run program (@...)' }, { value: 'variable', label: 'Set variable' }]
    },
    { key: 'program', label: 'Program call', kind: 'text', pattern: '^\\S+$', hint: '@program.prg(ARGS); the @ is optional', when: { key: 'action', values: ['program'] } },
    { key: 'variable', label: 'Variable', kind: 'text', pattern: NAME, suggest: 'fields', when: { key: 'action', values: ['variable'] } },
    {
      key: 'value', label: 'Value', kind: 'text', pattern: '^\\S*$', when: { key: 'action', values: ['variable'] },
      hint: 'Checkbox: checked;unchecked, such as 1;0. Others: empty sets the variable to blank'
    },
    row(), col(),
    tabs
  ],
  image: [
    { key: 'file', label: 'File', kind: 'image' },
    row(), col(), ...size(),
    { key: 'mode', label: 'Type', kind: 'flags', bits: [...STRETCH_BITS, ...TRANSPARENT_BITS] },
    tabs
  ],
  preview: [
    { key: 'path', label: 'File path', kind: 'text', hint: 'Such as $DIR_PICTS/file.vxp' },
    { key: 'field', label: 'Field name', kind: 'text', hint: 'Field holding the file name to preview; may be empty', suggest: 'fields' },
    row(), col(), ...size(),
    {
      key: 'mode', label: 'Mode', kind: 'flags', bits: [
        ...STRETCH_BITS, { bit: 4, label: 'Search subfolders' }, { bit: 8, label: 'Search custom branches' },
        { bit: 16, label: 'Search the shared branch' }, { bit: 32, label: 'Update list view also with multiple selection' }
      ]
    },
    { key: 'portType', label: 'Port type', kind: 'select', options: ['PORT_2D', 'PORT_3D', 'PORT_BMP'].map(v => ({ value: v, label: v })) },
    {
      key: 'portStyle', label: 'Port style', kind: 'select', hint: 'WIREFRAME, HIDDEN_LINE, OPENGL and LW are for 3D; SIMPLE_T is transparent for PORT_BMP',
      options: [
        { value: 'SIMPLE', label: 'SIMPLE (no frame or toolbar)' }, { value: '', label: 'empty (full frame)' },
        ...['WIREFRAME', 'HIDDEN_LINE', 'OPENGL', 'LW', 'SIMPLE_T'].map(v => ({ value: v, label: v }))
      ]
    },
    tabs
  ],
  listview: [
    row('Start row'), col('Start column'), ...size(),
    { key: 'mode', label: 'Mode', kind: 'flags', bits: STRETCH_BITS }
  ],
  bgimage: [
    { key: 'file', label: 'Background', kind: 'bgfile' },
    { key: 'width', label: 'Width', kind: 'bgsize' },
    { key: 'height', label: 'Height', kind: 'bgsize' },
    { key: 'transparency', label: 'Transparency', kind: 'range', min: 0, max: 255 },
    { key: 'mode', label: 'Mode', kind: 'flags', bits: TRANSPARENT_BITS },
    {
      key: 'placement', label: 'Placement', kind: 'select', options: [
        { value: 'FRAME', label: 'Inside the frame (FRAME)' }, { value: 'NOTFRAME', label: 'Outside the frame (NOTFRAME)' },
        { value: 'DIALOG', label: 'Whole dialog (DIALOG)' }
      ]
    },
    { key: 'alignment', label: 'Alignment', kind: 'select', options: ALIGNMENTS.map(a => ({ value: a, label: a === 'TILED' ? 'Tiled' : a })) },
    tabs
  ]
};

/** An element's properties as the panel shows them; every value is a string. */
export interface ElementProps {
  values: Record<string, string>;
  /** A button in the bottom bar: it has no row and column. */
  bottomBar?: boolean;
}

// ---- Reading --------------------------------------------------------------------------------------

const KEYWORDS: Record<string, string[]> = {
  text: ['text'], field: ['field'], pushbutton: ['button', 'pushbutton'], image: ['image'], preview: ['preview'],
  bgimage: ['bgimage'], listview: ['page_listview']
};

function typeOf(s: Statement): string | undefined {
  return Object.keys(KEYWORDS).find(type => KEYWORDS[type].includes(s.keyword));
}

function statementOf(statements: Statement[], ref: ElementRef): Statement | undefined {
  const keywords = KEYWORDS[ref.type] ?? [];
  return statements.find(s => s.valueStart >= 0 && keywords.includes(s.keyword) && s.index === ref.index);
}

const isString = (t?: Token) => !!t && (t.text.startsWith('"') || t.text.startsWith('{'));
const isNumber = (t?: Token) => !!t && /^\d+$/.test(t.text);

/** Text of tokens a to b as written (joined by a space when they are on different lines). */
function spanText(lines: string[], tokens: Token[], a: number, b: number): string {
  if (a > b) return '';
  return tokens[a].line === tokens[b].line
    ? lines[tokens[a].line].slice(tokens[a].start, tokens[b].end)
    : tokens.slice(a, b + 1).map(t => t.text).join(' ');
}

const unquote = (s: string) => s.replace(/^"([^]*)"$/, '$1');

/** Where each part of an element's statement is, as token numbers. */
interface Slots {
  [part: string]: number | undefined;
}

function slotsOf(type: string, tokens: Token[]): Slots {
  switch (type) {
    case 'text': return { row: 0, col: 1, from: 2, to: tokens.length - 1 };
    case 'field': {
      const ignore = tokens[5] && !isString(tokens[5]) ? 5 : undefined;
      const first = tokens.findIndex((t, n) => n > 4 && isString(t));
      let last = -1;
      tokens.forEach((t, n) => { if (n > 4 && isString(t)) last = n; });
      return { name: 0, type: 1, row: 2, col: 3, len: 4, ignore, from: first < 0 ? undefined : first, to: last < 0 ? undefined : last };
    }
    case 'pushbutton': {
      // Bottom bar: 100 rowpos col label
      const bottom = tokens[0]?.text === '100' && isNumber(tokens[2]);
      const at = bottom ? 3 : 2;
      const label = isString(tokens[at]) ? at : undefined;
      const from = label === undefined ? at : at + 1;
      return { row: bottom ? undefined : 0, col: bottom ? undefined : 1, bottom: bottom ? 1 : 0, label, after: at - 1, from, to: tokens.length - 1 };
    }
    case 'image': return { row: 0, col: 1, rows: 2, cols: 3, mode: 4, file: 5 };
    case 'preview': return { row: 0, col: 1, rows: 2, cols: 3, mode: 4, path: 5, field: 6, portType: 7, portStyle: 8 };
    case 'listview': return { row: 0, col: 1, rows: 2, cols: 3, mode: 4 };
  }
  return {};
}

const BOX_PIECE = /\s*\+\s*"\s*#\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\*\s*"/;
const BOX_INLINE = /\s*#\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\*/;

/** A text's content as the panel shows it, its box, and whether it was a string in braces ({"x"}). */
function readContent(raw: string): { content: string; box: [number, number] | null; braced: boolean } {
  const braced = raw.startsWith('{') && raw.endsWith('}');
  let inner = braced ? raw.slice(1, -1) : raw;
  let box: [number, number] | null = null;
  const m = inner.match(BOX_PIECE) ?? inner.match(BOX_INLINE);
  if (m) {
    box = [Number(m[1]), Number(m[2])];
    inner = inner.replace(m[0], '');
  }
  const plain = inner.match(/^\s*"([^"]*)"\s*$/);
  if (plain) return { content: plain[1], box, braced };
  return { content: braced ? `{${inner}}` : inner, box, braced: false };
}

/** Content written for the panel's text: {EXPRESSION} as is, anything else as a string. */
function writeContent(value: string, box: [number, number] | null, braced: boolean): string {
  const expression = /^\{[^]*\}$/.test(value.trim());
  const inner = expression ? value.trim().slice(1, -1) : `"${value.replace(/"/g, '')}"`;
  if (box) return `{${inner}+" #[${box[0]},${box[1]}]*"}`;
  return expression || braced ? `{${inner}}` : inner;
}

const PROGRAM = /@[^\s(]+(\s*\([^)]*\))?/;

function readButtonTail(tail: string): Record<string, string> {
  const assignment = parseButtonAssignment(tail);
  if (assignment) {
    return { kind: assignment.kind, action: 'variable', program: '', variable: assignment.name ?? '', value: assignment.value ?? '' };
  }
  const program = tail.match(PROGRAM);
  return { kind: 'select', action: program ? 'program' : 'none', program: program ? program[0].replace(/\s+\(/, '(') : '', variable: '', value: '' };
}

/** Flags as written: a + expression or a number. Undefined when it is something else. */
function flagValue(text: string): number | undefined {
  return /^\d+(\+\d+)*$/.test(text) ? text.split('+').reduce((all, n) => all | Number(n), 0) : undefined;
}

function tabIdsOf(statements: Statement[]): number[] {
  return statements.filter(s => s.keyword === 'page_header' && s.index !== undefined).map(s => s.index!).sort((a, b) => a - b);
}

/** Previews and backgrounds named in no tab's list are on every tab. */
const NO_LIST_IS_ALL = ['preview', 'bgimage'];

function readTabs(lines: string[], statements: Statement[], type: string, index: number, tabIds: number[]): string {
  const kind = itemKind(type === 'pushbutton' ? 'button' : type);
  const listed = new Set<number>();
  for (const s of statements) {
    if (s.valueStart < 0 || s.index === undefined || optListKind(s.keyword) !== kind) continue;
    if (listTokens(lines, s).some(t => Number(t.text) === index)) listed.add(s.index);
  }
  const on = tabIds.filter(id => listed.has(id));
  if (on.length === tabIds.length || (!on.length && NO_LIST_IS_ALL.includes(type))) return 'all';
  return on.join(' ');
}

/** group(n) statements and the field numbers they list. */
function groupsOf(lines: string[], statements: Statement[]): Array<{ s: Statement; members: number[]; fixed: Token[] }> {
  const fixed = groupFixedValues(lines, statements);
  return statements.filter(s => s.keyword === 'group' && s.valueStart >= 0 && s.index !== undefined).map(s => {
    const tokens = listTokens(lines, s);
    return { s, fixed: tokens.slice(0, fixed), members: tokens.slice(fixed).map(t => Number(t.text)).filter(n => Number.isInteger(n)) };
  });
}

/** Every indexed element's properties, by `type:index`. */
export function readElementProps(lines: string[]): Record<string, ElementProps> {
  const statements = parseStatements(lines);
  const tabIds = tabIdsOf(statements);
  const groups = groupsOf(lines, statements);
  const backgrounds = new Map(findBackgrounds(lines).map(b => [b.index, b]));
  const out: Record<string, ElementProps> = {};
  for (const s of statements) {
    const type = typeOf(s);
    if (!type || s.index === undefined || s.valueStart < 0 || out[keyOf({ type, index: s.index })]) continue;
    const tokens = valueTokens(lines, s);
    const slots = slotsOf(type, tokens);
    const text = (part: string) => { const n = slots[part]; return n !== undefined && tokens[n] ? tokens[n].text : ''; };
    const values: Record<string, string> = {};
    let bottomBar: boolean | undefined;
    if (slots.row !== undefined) {
      values.row = text('row');
      values.col = text('col');
    }
    switch (type) {
      case 'text': {
        const c = readContent(spanText(lines, tokens, slots.from!, slots.to!));
        Object.assign(values, { content: c.content, boxRows: c.box ? String(c.box[0]) : '', boxCols: c.box ? String(c.box[1]) : '' });
        break;
      }
      case 'field': {
        const name = text('name');
        const valueTokens = slots.from === undefined ? [] : tokens.slice(slots.from, slots.to! + 1).filter(isString);
        Object.assign(values, {
          name: name.replace(/["<>]/g, ''), nameAngle: name.includes('<') ? '1' : '', nameQuoted: name.startsWith('"') ? '1' : '',
          type: text('type'), len: text('len'), ignore: text('ignore'),
          values: valueTokens.map(t => unquote(t.text)).join('\n')
        });
        const group = groups.find(g => g.members.includes(s.index!));
        values.group = group ? String(group.s.index) : '';
        break;
      }
      case 'pushbutton': {
        bottomBar = slots.bottom === 1;
        const label = slots.label === undefined ? '' : readContent(text('label')).content;
        values.label = label;
        Object.assign(values, readButtonTail(spanText(lines, tokens, slots.from!, slots.to!)));
        break;
      }
      case 'image':
        Object.assign(values, { rows: text('rows'), cols: text('cols'), mode: text('mode'), file: readContent(text('file')).content });
        break;
      case 'preview':
        Object.assign(values, {
          rows: text('rows'), cols: text('cols'), mode: text('mode'), path: unquote(text('path')), field: unquote(text('field')),
          portType: unquote(text('portType')), portStyle: text('portStyle') === '""' ? '' : unquote(text('portStyle'))
        });
        break;
      case 'listview':
        Object.assign(values, { rows: text('rows'), cols: text('cols'), mode: text('mode') });
        break;
      case 'bgimage': {
        const b = backgrounds.get(s.index);
        const show = (v: number | string | null | undefined) => v === null || v === undefined ? '' : String(v);
        Object.assign(values, {
          width: show(b?.width), height: show(b?.height), transparency: show(b?.transparency),
          mode: tokens[3]?.text ?? '', placement: show(b?.placement), alignment: show(b?.alignment), file: show(b?.file)
        });
        break;
      }
    }
    if (tabIds.length && type !== 'listview') values.tabs = readTabs(lines, statements, type, s.index, tabIds);
    out[keyOf({ type, index: s.index })] = bottomBar ? { values, bottomBar } : { values };
  }
  return out;
}

// ---- Changing -------------------------------------------------------------------------------------

/** Whether a value fits its property, before the property's own rules. */
function fits(def: PropDef, value: string): boolean {
  const int = (min = -Infinity, max = Infinity) => /^-?\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
  switch (def.kind) {
    case 'int': return (def.optional && value === '') || int(def.min, def.max);
    case 'range': return int(def.min, def.max);
    case 'bgsize': return int(-1);
    case 'check': return value === '' || value === '1';
    case 'select': return !!def.options?.some(o => o.value === value);
    case 'tabs': return value === 'all' || /^\d+( \d+)*$/.test(value);
    case 'flags': return false; // setElementFlag
    case 'text': case 'image': case 'bgfile':
      return !/[\r\n]/.test(value) && (!def.pattern || new RegExp(def.pattern).test(value));
    case 'lines': return true;
  }
}

/** Replace the text from token a to token b (inclusive). */
function replaceSpan(lines: string[], a: Token, b: Token, text: string): void {
  lines[a.line] = lines[a.line].slice(0, a.start) + text + lines[b.line].slice(b.end);
  lines.splice(a.line + 1, b.line - a.line);
}

/** Remove tokens a to b and the space before them, which ends where token before ends. */
function removeSpan(lines: string[], before: Token, b: Token): void {
  replaceSpan(lines, { ...before, start: before.end }, b, '');
}

function insertAfter(lines: string[], token: Token, text: string): void {
  lines[token.line] = lines[token.line].slice(0, token.end) + ' ' + text + lines[token.line].slice(token.end);
}

/** A string keeps its delimiters: "x", {x} and {"x"}. */
function rewrap(old: string, value: string): string {
  const clean = value.replace(/["{}]/g, '');
  const m = old.match(/^(\{\s*"?|")[^]*?("?\s*\}|")$/);
  return m ? m[1] + clean + m[2] : `"${clean}"`;
}

/**
 * Change one property of an element. The value is a string as the panel holds it. Only that property's
 * text changes. Undefined when the element isn't found or the value doesn't fit; the same lines when
 * the property already has the value.
 */
export function setElementProp(source: string[], ref: ElementRef, key: string, value: string): string[] | undefined {
  const def = PROP_DEFS[ref.type]?.find(d => d.key === key);
  if (!def || typeof value !== 'string' || !fits(def, value)) return undefined;
  const statements = parseStatements(source);
  const s = statementOf(statements, ref);
  if (!s) return undefined;
  const current = readElementProps(source)[keyOf(ref)]?.values ?? {};
  if (current[key] === value) return [...source];
  if (key === 'tabs') return setTabs(source, statements, ref, value);
  if (key === 'group') return setGroup(source, ref.index, Number(value));
  if (ref.type === 'bgimage') return setBackground(source, ref.index, key, value);

  const lines = [...source];
  const tokens = valueTokens(lines, s);
  const slots = slotsOf(ref.type, tokens);
  const token = (part: string) => { const n = slots[part]; return n === undefined ? undefined : tokens[n]; };
  const put = (part: string, text: string) => {
    const t = token(part);
    if (!t) return undefined;
    replaceSpan(lines, t, t, text);
    return lines;
  };

  switch (`${ref.type}.${key}`) {
    case 'text.content': case 'text.boxRows': case 'text.boxCols': {
      const from = tokens[slots.from!];
      const to = tokens[slots.to!];
      const c = from ? readContent(spanText(lines, tokens, slots.from!, slots.to!)) : { content: '', box: null, braced: false };
      let box = c.box;
      if (key === 'boxRows') box = value === '' ? null : [Number(value), box?.[1] ?? 20];
      if (key === 'boxCols') box = value === '' ? null : [box?.[0] ?? 3, Number(value)];
      const written = writeContent(key === 'content' ? value : c.content, box, c.braced);
      if (from) replaceSpan(lines, from, to, written);
      else insertAfter(lines, tokens[1], written);
      return lines;
    }
    case 'field.name': case 'field.nameAngle': case 'field.nameQuoted': {
      const v = { ...current, [key]: value };
      if (!new RegExp(NAME).test(v.name)) return undefined;
      const name = v.nameAngle ? `<${v.name}>` : v.name;
      return put('name', v.nameQuoted ? `"${name}"` : name);
    }
    case 'field.ignore': {
      if (token('ignore')) return put('ignore', value);
      const len = token('len');
      if (!len) return undefined;
      insertAfter(lines, len, value);
      return lines;
    }
    case 'field.values': {
      const items = value.split('\n').map(v => v.replace(/"/g, '').trim()).filter(Boolean).map(v => `"${v}"`).join(' ');
      const first = slots.from === undefined ? undefined : tokens[slots.from];
      const last = slots.to === undefined ? undefined : tokens[slots.to];
      if (first && last) {
        if (items) replaceSpan(lines, first, last, items);
        else removeSpan(lines, tokens[slots.from! - 1], last);
        return lines;
      }
      if (!items) return lines;
      if (token('ignore')) {
        // After everything there is: some forms have more numbers after the ignore value
        insertAfter(lines, tokens[tokens.length - 1], items);
      } else {
        const len = token('len');
        if (!len) return undefined;
        const only = lines.some(l => /^\s*vxdbase_winstyle\s*=\s*only\b/i.test(l));
        insertAfter(lines, len, `${only ? 4 : 7} ${items}`);
      }
      return lines;
    }
    case 'pushbutton.label': {
      const label = token('label');
      const old = label ? readContent(label.text) : { braced: false };
      const written = writeContent(value, null, old.braced);
      if (label) return put('label', written);
      const after = tokens[slots.after!];
      if (!after) return undefined;
      insertAfter(lines, after, written);
      return lines;
    }
    case 'pushbutton.kind': case 'pushbutton.action': case 'pushbutton.program': case 'pushbutton.variable': case 'pushbutton.value':
      return setButtonTail(lines, tokens, slots, current, key, value);
    case 'image.file':
      return put('file', rewrap(token('file')?.text ?? '""', value));
    case 'preview.path': case 'preview.field':
      return put(key, `"${value.replace(/"/g, '')}"`);
    case 'preview.portType':
      return put('portType', token('portType')?.text.startsWith('"') ? `"${value}"` : value);
    case 'preview.portStyle': {
      const written = value === '' ? '""' : value;
      if (token('portStyle')) return put('portStyle', written);
      const portType = token('portType');
      if (!portType) return undefined;
      insertAfter(lines, portType, written);
      return lines;
    }
  }
  // Plain numbers: row, col, rows, cols, len
  if (['row', 'col', 'rows', 'cols', 'len'].includes(key)) return put(key, value);
  return undefined;
}

/** A button's action after its label: CHECKBOX VAR=value, RADIO VAR=value, @program P or VAR=value. */
function setButtonTail(lines: string[], tokens: Token[], slots: Slots, current: Record<string, string>, key: string, value: string): string[] | undefined {
  if (key === 'action' && current.kind !== 'select') return undefined;
  const from = tokens[slots.from!];
  const to = tokens[slots.to!];
  const tail = from ? spanText(lines, tokens, slots.from!, slots.to!) : '';
  let written: string | undefined;
  // Only the changed part of an existing program call or assignment
  if (key === 'program' && current.action === 'program') {
    written = tail.replace(PROGRAM, value.startsWith('@') ? value : '@' + value);
  } else if ((key === 'variable' || key === 'value') && current.action === 'variable') {
    const v = { ...current, [key]: value };
    written = tail.replace(/(\$?[A-Z0-9_]+)\s*=\s*(\S*)/i, () => `${v.variable}=${v.value}`);
  } else {
    const v = { ...current, [key]: value };
    if (key === 'kind' || key === 'action') {
      if (v.kind !== 'select') v.action = 'variable';
      if (v.action === 'variable') {
        v.variable = v.variable || 'VAR';
        v.value = v.value || (v.kind === 'checkbox' ? '1;0' : '1');
      }
      if (v.action === 'program') v.program = v.program || 'program.prg';
    }
    if (v.kind === 'checkbox' || v.kind === 'radio') written = `${v.kind.toUpperCase()} ${v.variable}=${v.value}`;
    else if (v.action === 'program') written = `${v.program.startsWith('@') ? '' : '@'}${v.program} P`;
    else if (v.action === 'variable') written = `${v.variable}=${v.value}`;
    else written = '';
  }
  if (from) {
    if (written) replaceSpan(lines, from, to, written);
    else removeSpan(lines, tokens[slots.from! - 1], to);
  } else if (written) {
    const last = tokens[slots.from! - 1];
    if (!last) return undefined;
    insertAfter(lines, last, written);
  }
  return lines;
}

function setBackground(source: string[], index: number, key: string, value: string): string[] | undefined {
  const edit: Record<string, number | string> = {};
  if (['width', 'height', 'transparency'].includes(key)) edit[key] = Number(value);
  else if (key === 'placement' || key === 'alignment' || key === 'file') edit[key] = value;
  else return undefined;
  if (key === 'placement' && !PLACEMENTS.includes(value)) return undefined;
  return editBackground(source, index, edit);
}

/** Show an element on the given tabs. Lists that already say so are left as they are. */
function setTabs(source: string[], statements: Statement[], ref: ElementRef, value: string): string[] | undefined {
  const tabIds = tabIdsOf(statements);
  if (!tabIds.length || ref.type === 'listview') return undefined;
  const asked = value === 'all' ? tabIds : value.split(' ').map(Number);
  if (!asked.length || asked.some(id => !tabIds.includes(id))) return undefined;
  if (ref.type === 'bgimage') return editBackground(source, ref.index, {}, value === 'all' ? 'all' : asked);
  // Named in no list: on every tab
  const wanted = value === 'all' && NO_LIST_IS_ALL.includes(ref.type) ? [] : asked;
  const lines = [...source];
  const listed = new Set<number>();
  updateOptLists(lines, ref.type, (list, tabId) => {
    if (!list.includes(ref.index)) return undefined;
    if (wanted.includes(tabId)) {
      listed.add(tabId);
      return undefined;
    }
    return list.filter(n => n !== ref.index);
  });
  for (const tab of wanted) if (!listed.has(tab)) addToTab(lines, ref.type, ref.index, tab);
  return lines;
}

/** Rewrite a group statement with these values, keeping how it wraps. */
function rewriteGroup(lines: string[], s: Statement, items: string[]): void {
  const collected = collectContinuedStatement(lines, s.startLine);
  const wrapAt = collected.endIndex > s.startLine ? wrapWidthFromFirstLine(lines[s.startLine]) : undefined;
  lines.splice(s.startLine, collected.endIndex - s.startLine + 1, ...formatIndexStatement(statementKeyword(lines[s.startLine]), items, wrapAt));
}

/** Move a field to the end of group(n), which is made like group(1) when there is none. Emptied groups other than group(1) go. */
function setGroup(source: string[], field: number, group: number): string[] | undefined {
  if (!Number.isInteger(group) || group < 1) return undefined;
  const lines = [...source];
  const groups = groupsOf(lines, parseStatements(lines));
  // Bottom up, so the lines of the groups above stay where they are
  for (const g of [...groups].reverse()) {
    if (g.s.index === group || !g.members.includes(field)) continue;
    const rest = g.members.filter(n => n !== field);
    if (!rest.length && g.s.index !== 1) lines.splice(g.s.startLine, g.s.endLine - g.s.startLine + 1);
    else rewriteGroup(lines, g.s, [...g.fixed.map(t => t.text), ...rest.map(String)]);
  }
  const after = groupsOf(lines, parseStatements(lines));
  const target = after.find(g => g.s.index === group);
  if (target) {
    if (!target.members.includes(field)) rewriteGroup(lines, target.s, [...target.fixed.map(t => t.text), ...target.members.map(String), String(field)]);
    return lines;
  }
  const model = after.find(g => g.s.index === 1) ?? after[0];
  const fixed = model ? model.fixed.map(t => t.text) : groupFixedValues(lines, parseStatements(lines)) === 3 ? ['0', '1', '0'] : ['0', '1'];
  const line = `group(${group})= ${[...fixed, String(field)].join(' ')}`;
  const last = after[after.length - 1];
  if (last) lines.splice(last.s.endLine + 1, 0, line);
  else insertIntoSection(lines, Section.Group, [line]);
  return lines;
}

/**
 * Turn one bit of a flags property on or off. A + expression keeps its order and gets or loses that term;
 * a single bit counts as a sum of one; any other number stays a number.
 */
export function setElementFlag(source: string[], ref: ElementRef, key: string, bit: number, on: boolean): string[] | undefined {
  const def = PROP_DEFS[ref.type]?.find(d => d.key === key);
  if (!def || def.kind !== 'flags' || !def.bits?.some(b => b.bit === bit)) return undefined;
  const s = statementOf(parseStatements(source), ref);
  if (!s) return undefined;
  const tokens = valueTokens(source, s);
  const n = ref.type === 'bgimage' ? (key === 'mode' ? 3 : undefined) : slotsOf(ref.type, tokens)[key];
  const token = n === undefined ? undefined : tokens[n];
  const old = token ? flagValue(token.text) : undefined;
  if (!token || old === undefined) return undefined;
  if (((old & bit) !== 0) === on) return [...source];
  const parts = token.text.split('+').map(Number);
  const isBit = (v: number) => v > 0 && (v & (v - 1)) === 0;
  let written: string;
  if (parts.length === 1 && parts[0] !== 0 && !isBit(parts[0])) {
    written = String(on ? old | bit : old & ~bit);
  } else if (on) {
    const terms = parts.filter(p => p !== 0);
    const descending = terms.length > 1 && terms.every((p, i) => i === 0 || terms[i - 1] > p);
    const at = terms.findIndex(p => descending ? p < bit : p > bit);
    terms.splice(at < 0 ? terms.length : at, 0, bit);
    written = terms.join('+');
  } else if (parts.includes(bit)) {
    written = parts.filter(p => p !== bit).join('+') || '0';
  } else {
    // The bit is inside a term such as 3: write the other terms, and that term without the bit
    written = parts.map(p => p & ~bit).filter(p => p !== 0).join('+') || '0';
  }
  const lines = [...source];
  replaceSpan(lines, token, token, written);
  return lines;
}
