// Copies, cuts and pastes form elements and triggers as plain FRM lines. No VS Code dependency.

import { insertBackground } from './backgrounds';
import {
  ElementRef, SECTION_OF, addFieldToGroup1, addToTab, deleteElements, keyOf, matchPosition, revisionOf
} from './elementEdits';
import { findElement, findElementStatements, findTriggerStatements, lineContinues } from './elementLookup';
import { Section, insertIntoSection, isBlankLine } from './frmSections';
import { newButtonKeyword } from './frmStatements';

/** A trigger as the preview last drew it. Its line may have moved since. */
export interface TriggerRef { line: number; target: string; program: string; }

/** Where pasted elements go, and what is known about where the text came from. */
export interface PasteOptions {
  /** Cell for the top-left corner of what is pasted; without one, the positions in the text are used. */
  cell?: { row: number; col: number } | null;
  /** Size of the form in cells. */
  rows: number;
  cols: number;
  /** The active tab, when the form has tabs. */
  tabId?: number | null;
  /** The text was last copied or cut from this same form. */
  sameForm?: boolean;
  /** It was cut from this form: indexes that are still free are used again. */
  restoreIndexes?: boolean;
  /** Cells an element covers. */
  sizeOf?: (statement: string[]) => { rows: number; cols: number };
}

export interface PasteResult {
  lines: string[];
  /** Keys of the pasted elements on the form and of backgrounds. */
  keys: string[];
  /** Indexes of the pasted hidden fields. */
  hiddenFields: number[];
  /** Lines of the pasted triggers, in `lines`. */
  triggerLines: number[];
  /** Lines of the text that were not used. */
  skipped: number;
  tooBig: boolean;
  /** Targets of triggers that now fire from whatever field has that index in this form. */
  keptTargets: string[];
  /** Targets of triggers left out because the form has no such field. */
  missingTargets: string[];
  /** Triggers left out because the form already has them. */
  duplicateTriggers: number;
}

const TRIGGER_LINE = /^\s*trigger\s*=\s*(\$?\w+)\s+(\S+)/i;

export function validTriggerRefs(items: unknown): TriggerRef[] {
  if (!Array.isArray(items)) return [];
  return (items as TriggerRef[]).filter(t => !!t && Number.isInteger(t.line) && typeof t.target === 'string' && typeof t.program === 'string');
}

/** First and last line of each wanted trigger, each once. */
function findTriggers(lines: string[], refs: TriggerRef[]): Array<{ startLine: number; endLine: number }> {
  const all = findTriggerStatements(lines);
  const found = new Set<(typeof all)[number]>();
  for (const ref of refs) {
    const nearest = all.filter(t => {
      const m = !found.has(t) && lines[t.startLine].match(TRIGGER_LINE);
      return m && m[1] === ref.target && m[2] === ref.program;
    }).sort((a, b) => Math.abs(a.startLine - ref.line) - Math.abs(b.startLine - ref.line))[0];
    if (nearest) found.add(nearest);
  }
  return [...found];
}

/** The statements of elements and triggers, verbatim and in file order. */
export function copyStatements(lines: string[], refs: ElementRef[], triggers: TriggerRef[]): { text: string; count: number } {
  const elements = refs.flatMap(ref => findElement(lines, ref.type, ref.index) ?? []);
  const statements = [...elements, ...findTriggers(lines, triggers)].sort((a, b) => a.startLine - b.startLine);
  return {
    text: statements.flatMap(s => lines.slice(s.startLine, s.endLine + 1)).map(l => l + '\n').join(''),
    count: statements.length
  };
}

/** Remove elements, with their indexes in group(1) and the opt_* lists, and triggers. */
export function deleteStatements(source: string[], refs: ElementRef[], triggers: TriggerRef[]): { lines: string[]; deleted: ElementRef[]; deletedTriggers: number } {
  const lines = [...source];
  const found = findTriggers(lines, triggers).sort((a, b) => b.startLine - a.startLine);
  for (const t of found) lines.splice(t.startLine, t.endLine - t.startLine + 1);
  return { ...deleteElements(lines, refs), deletedTriggers: found.length };
}

const isHidden = (type: string, row: number, col: number) => type === 'field' && (row === 1000 || col === 1000);

/** Bottom-bar buttons: 100 rowpos 0 {label} */
const BOTTOM_BAR = /^\s*\w+\s*\(\s*\d+\s*\)\s*=\s*100\s+\d+\s+\d/;

/** A trigger line without differences that don't matter. */
function triggerId(statement: string[]): string {
  return statement.join(' ').replace(/^\s*trigger\s*=/i, '').trim().replace(/\s+/g, ' ');
}

/** A statement's lines. One cut off in the middle must not swallow the line it ends up above. */
function statementLines(lines: string[], s: { startLine: number; endLine: number }): string[] {
  const statement = lines.slice(s.startLine, s.endLine + 1);
  const last = statement.length - 1;
  if (lineContinues(statement[last])) statement[last] = statement[last].trimEnd().replace(/\s*\\$/, '');
  return statement;
}

/** Add the elements and triggers found in a text. Undefined when it has none. */
export function pasteStatements(source: string[], text: string, options: PasteOptions): PasteResult | undefined {
  const pasted = text.split(/\r?\n/);
  let used = 0;

  const items: Array<{ type: string; index: number; row: number; col: number; hidden: boolean; m: RegExpMatchArray; statement: string[] }> = [];
  const backgrounds: Array<{ type: string; index: number; statement: string[] }> = [];
  for (const s of findElementStatements(pasted)) {
    if (s.type === 'bgimage') {
      backgrounds.push({ type: s.type, index: s.index, statement: statementLines(pasted, s) });
      used += s.endLine - s.startLine + 1;
      continue;
    }
    const m = matchPosition(pasted[s.startLine], s.type);
    if (!m || (s.type === 'pushbutton' && BOTTOM_BAR.test(pasted[s.startLine]))) continue;
    const row = Number(m[2]), col = Number(m[4]);
    items.push({ type: s.type, index: s.index, row, col, hidden: isHidden(s.type, row, col), m, statement: statementLines(pasted, s) });
    used += s.endLine - s.startLine + 1;
  }
  const triggers = findTriggerStatements(pasted);
  for (const t of triggers) used += t.endLine - t.startLine + 1;
  if (!items.length && !backgrounds.length && !triggers.length) return undefined;

  const lines = [...source];
  const result: PasteResult = {
    lines, keys: [], hiddenFields: [], triggerLines: [], skipped: pasted.filter(l => !isBlankLine(l)).length - used,
    tooBig: false, keptTargets: [], missingTargets: [], duplicateTriggers: 0
  };
  const existing = findElementStatements(source);

  // How far everything moves
  const visible = items.filter(i => !i.hidden);
  let dRow = 0, dCol = 0;
  if (visible.length) {
    const top = Math.min(...visible.map(i => i.row)), left = Math.min(...visible.map(i => i.col));
    const sizes = visible.map(i => options.sizeOf?.(i.statement) ?? { rows: 1, cols: 1 });
    const lastRow = options.rows - Math.max(...visible.map((i, n) => i.row - top + sizes[n].rows)) + 1;
    const lastCol = options.cols - Math.max(...visible.map((i, n) => i.col - left + sizes[n].cols)) + 1;
    result.tooBig = lastRow < 1 || lastCol < 1;
    const fit = (wanted: number, last: number) => Math.max(1, Math.min(wanted, last));
    dRow = fit(options.cell?.row ?? top, lastRow) - top;
    dCol = fit(options.cell?.col ?? left, lastCol) - left;
    if (!options.cell) {
      const taken = new Set(existing.map(s => {
        const m = matchPosition(source[s.startLine], s.type);
        return m && `${s.type}:${Number(m[2])}:${Number(m[4])}`;
      }));
      const free = (d: number) => !visible.some(i => taken.has(`${i.type}:${i.row + d}:${i.col + dCol}`));
      for (let d = dRow; d === dRow || top + d <= lastRow; d++) {
        if (!free(d)) continue;
        dRow = d;
        break;
      }
    }
  }

  // Indexes
  const taken = new Set(existing.map(keyOf));
  const indexes = new Map<ElementRef, number>();
  if (options.restoreIndexes) {
    for (const item of [...items, ...backgrounds]) {
      if (taken.has(keyOf(item))) continue;
      indexes.set(item, item.index);
      taken.add(keyOf(item));
    }
  }
  const nextIndex: Record<string, number> = {};
  const nextFree = (item: ElementRef) =>
    indexes.get(item) ?? (nextIndex[item.type] = (nextIndex[item.type] ?? 1) + 1) - 1;
  for (const s of [...existing, ...indexes.keys()]) nextIndex[s.type] = Math.max(nextIndex[s.type] ?? 1, s.index + 1);

  const fieldIndexes = new Map<number, number>();
  const revision = revisionOf(source);
  for (const item of items) {
    const index = nextFree(item);
    const { m, statement } = item;
    const at = item.hidden ? `${m[2]}${m[3]}${m[4]}` : `${item.row + dRow}${m[3]}${item.col + dCol}`;
    const start = m[1].replace(/^(\s*)(\w+)(\s*\(\s*)\d+/, (_all, indent: string, keyword: string, open: string) =>
      indent + (item.type === 'pushbutton' ? newButtonKeyword(lines) : keyword) + open + index);
    statement[0] = start + at + statement[0].slice(m[0].length);
    insertIntoSection(lines, SECTION_OF[item.type], statement);
    if (item.type === 'field') {
      addFieldToGroup1(lines, index, revision);
      if (!fieldIndexes.has(item.index)) fieldIndexes.set(item.index, index);
    }
    if (options.tabId !== undefined && options.tabId !== null) addToTab(lines, item.type, index, options.tabId);
    if (item.hidden) result.hiddenFields.push(index);
    else result.keys.push(keyOf({ type: item.type, index }));
  }

  // Backgrounds have no position and, named in no list, are shown on every tab
  for (const item of backgrounds) {
    const index = nextFree(item);
    item.statement[0] = item.statement[0].replace(/\(\s*\d+/, `(${index}`);
    insertBackground(lines, item.statement);
    result.keys.push(keyOf({ type: item.type, index }));
  }

  // Triggers come last in a file, so nothing is inserted above the ones already added
  const known = new Map(findTriggerStatements(lines).map(t => [triggerId(lines.slice(t.startLine, t.endLine + 1)), t]));
  const added: string[] = [];
  for (const t of triggers) {
    const statement = statementLines(pasted, t);
    if (/^\d+$/.test(t.target) && Number(t.target) > 0) {
      const index = Number(t.target);
      const pastedAs = fieldIndexes.get(index);
      if (pastedAs !== undefined) {
        statement[0] = statement[0].replace(/^(\s*trigger\s*=\s*)\d+/i, (_all, start: string) => start + pastedAs);
      } else if (!options.sameForm) {
        if (!existing.some(s => s.type === 'field' && s.index === index)) {
          result.missingTargets.push(t.target);
          continue;
        }
      }
    }
    const id = triggerId(statement);
    if (known.has(id) || added.includes(id)) {
      result.duplicateTriggers++;
      continue;
    }
    if (/^\d+$/.test(t.target) && Number(t.target) > 0 && !fieldIndexes.has(Number(t.target)) && !options.sameForm) result.keptTargets.push(t.target);
    insertIntoSection(lines, Section.Trigger, statement);
    added.push(id);
  }
  result.triggerLines = findTriggerStatements(lines)
    .filter(t => added.includes(triggerId(lines.slice(t.startLine, t.endLine + 1)))).map(t => t.startLine);
  return result;
}
