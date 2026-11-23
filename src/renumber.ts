// Renumbers items and converts pushbuttons to buttons. No VS Code dependency.
import {
  applyLineEdits, groupFixedValues, itemsOf, LineEdit, listTokens, parseStatements, referenceTokens, Statement,
} from './frmStatements';

export interface LineRange { start: number; end: number; }

export type RenumberResult = { lines: string[] } | { error: string };

/**
 * Number the items of one kind in file order and update every reference to them.
 * Without ranges, all items are numbered from 1. With ranges, only items starting in them are
 * numbered, from their lowest index, skipping indexes that other items use.
 */
export function renumberItems(lines: string[], kind: 'field' | 'text' | 'button', ranges: LineRange[] = []): RenumberResult {
  const statements = parseStatements(lines);
  const items = itemsOf(statements, kind);
  const selected = ranges.length
    ? items.filter(s => ranges.some(r => s.startLine >= r.start && s.startLine <= r.end))
    : items;
  if (!selected.length) {
    return { error: ranges.length ? `No ${kind} lines in the selection.` : `No ${kind} lines in this form.` };
  }

  const groupFixed = groupFixedValues(lines, statements);
  const references = statements.flatMap(s => referenceTokens(lines, s, kind, groupFixed));
  const referenced = new Set(references.map(t => Number(t.text)));

  const byIndex = new Map<number, Statement[]>();
  for (const s of items) {
    if (s.index !== undefined) byIndex.set(s.index, [...(byIndex.get(s.index) ?? []), s]);
  }
  for (const [index, group] of byIndex) {
    if (group.length > 1 && referenced.has(index) && group.some(s => selected.includes(s))) {
      return {
        error: `${kind}(${index}) is declared on lines ${group.map(s => s.startLine + 1).join(', ')}, so references to it are ambiguous. ` +
          'Give these lines different indexes and renumber again.',
      };
    }
  }

  const selectedSet = new Set(selected);
  const taken = new Set(items.filter(s => !selectedSet.has(s)).map(s => s.index));
  const oldIndexes = selected.flatMap(s => s.index !== undefined ? [s.index] : []);
  let next = ranges.length && oldIndexes.length ? Math.min(...oldIndexes) : 1;

  const edits: LineEdit[] = [];
  const oldToNew = new Map<number, number>();
  for (const s of selected) {
    while (taken.has(next)) next++;
    if (s.index !== undefined) oldToNew.set(s.index, next);
    if (s.index !== next) {
      edits.push({ line: s.startLine, start: s.indexStart, end: s.indexEnd, text: `(${next})` });
    }
    next++;
  }
  for (const t of references) {
    const to = oldToNew.get(Number(t.text));
    if (to !== undefined && to !== Number(t.text)) {
      edits.push({ line: t.line, start: t.start, end: t.end, text: String(to) });
    }
  }
  return { lines: applyLineEdits(lines, edits) };
}

/**
 * Rename `pushbutton` to `button` and `opt_pushbutton` to `opt_button`. A pushbutton whose index a
 * button also uses gets the next free one, and the numbers in `opt_pushbutton` lists follow it.
 * A tab's two lists are merged. `newLine` maps an original line number to its new one.
 */
export function convertPushbuttons(lines: string[]): { lines: string[]; newLine: (line: number) => number } {
  const statements = parseStatements(lines).filter(s => s.valueStart >= 0);
  const buttons = statements.filter(s => s.keyword === 'button');
  const pushbuttons = statements.filter(s => s.keyword === 'pushbutton');
  const buttonIndexes = new Set(buttons.map(s => s.index));
  let nextFree = Math.max(0, ...[...buttons, ...pushbuttons].map(s => s.index ?? 0)) + 1;

  const moved = new Map<number, number>();
  for (const s of pushbuttons) {
    if (s.index !== undefined && buttonIndexes.has(s.index) && !moved.has(s.index)) moved.set(s.index, nextFree++);
  }

  const edits: LineEdit[] = [];
  const rename = (s: Statement, to: string) => edits.push({ line: s.startLine, start: s.keywordStart, end: s.keywordEnd, text: to });
  for (const s of pushbuttons) {
    rename(s, 'button');
    const to = s.index !== undefined ? moved.get(s.index) : undefined;
    if (to !== undefined) edits.push({ line: s.startLine, start: s.indexStart, end: s.indexEnd, text: `(${to})` });
  }

  const removed = new Set<number>();
  const replaced = new Map<number, string>();
  const optButtons = statements.filter(s => s.keyword === 'opt_button');
  const added = new Map<Statement, string[]>();
  for (const s of statements.filter(x => x.keyword === 'opt_pushbutton')) {
    const tokens = listTokens(lines, s);
    const newText = (text: string) => /^\d+$/.test(text) ? String(moved.get(Number(text)) ?? text) : text;
    const target = optButtons.find(o => o.index === s.index);
    if (!target) {
      rename(s, 'opt_button');
      for (const t of tokens) {
        if (newText(t.text) !== t.text) edits.push({ line: t.line, start: t.start, end: t.end, text: newText(t.text) });
      }
      continue;
    }
    // Merge into the tab's opt_button list; the statement's lines go away, its comments stay
    const extra = added.get(target) ?? [];
    const present = new Set([...listTokens(lines, target).map(t => t.text), ...extra]);
    for (const t of tokens) {
      const text = newText(t.text);
      if (!present.has(text)) {
        present.add(text);
        extra.push(text);
      }
    }
    added.set(target, extra);
    for (let line = s.startLine; line <= s.endLine; line++) {
      const bang = lines[line].indexOf('!');
      if (bang >= 0) replaced.set(line, lines[line].slice(bang).replace(/\\\s*$/, ''));
      else removed.add(line);
    }
  }
  for (const [target, extra] of added) {
    if (!extra.length) continue;
    const last = listTokens(lines, target).pop();
    const at = last ? { line: last.line, start: last.end } : { line: target.startLine, start: target.valueStart };
    edits.push({ ...at, end: at.start, text: ' ' + extra.join(' ') });
  }

  const edited = applyLineEdits(lines, edits);
  replaced.forEach((text, line) => { edited[line] = text; });
  const removedLines = [...removed];
  return {
    lines: edited.filter((_, i) => !removed.has(i)),
    newLine: line => line - removedLines.filter(r => r < line).length,
  };
}
