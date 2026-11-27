// Checks an FRM file for problems. No VS Code dependency.
import { backgroundProblems } from './backgrounds';
import { EXO_FIELD, flagValue } from './listview';
import {
  buttonSpellings, firstLineValue, groupFixedValues, ItemKind, itemPosition, itemsOf, listTokens, optListKind,
  parseStatements, referenceTokens, Statement,
} from './frmStatements';

export const MIXED_BUTTONS = 'mixed-buttons';

export interface Problem {
  startLine: number;
  endLine: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

const KINDS: ItemKind[] = ['text', 'field', 'button', 'image', 'bgimage', 'preview'];

/** Header statements with a required value format. */
const HEADER_CHECKS: Record<string, { value: RegExp; message: string }> = {
  port_size: { value: /^\s*\d+\s+\d+/, message: 'port_size must be followed by = and two numbers' },
  text_font: { value: /^\s*\d+/, message: 'text_font must be followed by = and a number' },
  field_font: { value: /^\s*\d+/, message: 'field_font must be followed by = and a number' },
  vxdbase_winstyle: { value: /^\s*(only|VXUI)/i, message: 'vxdbase_winstyle must be followed by = and either "only" or "VXUI"' },
  header: { value: /^\s*(".*"|{.*})/, message: 'header must be followed by = and a string or {value}' },
};

function describe(s: Statement): string {
  return `${s.keyword[0].toUpperCase()}${s.keyword.slice(1)}(${s.index})`;
}

/** imageExists: whether an image file can be found; undefined when that isn't known. */
export function findProblems(lines: string[], imageExists?: (file: string) => boolean | undefined): Problem[] {
  const problems: Problem[] = [];
  const report = (s: Statement, severity: Problem['severity'], message: string, code?: string) =>
    problems.push({ startLine: s.startLine, endLine: s.endLine, severity, message, code });

  const statements = parseStatements(lines);
  const groupFixed = groupFixedValues(lines, statements);
  const references = (s: Statement, kind: ItemKind) => referenceTokens(lines, s, kind, groupFixed).map(t => Number(t.text));
  // List view: the indexes of the non-exo fields, which are table columns
  const listForm = statements.some(s => s.keyword === 'page_listview' && s.valueStart >= 0);
  const columnIndexes = new Set(listForm
    ? itemsOf(statements, 'field').filter(s => s.index !== undefined && !isExoField(lines, s)).map(s => s.index)
    : []);

  for (const s of statements) {
    const check = HEADER_CHECKS[s.keyword];
    if (check && !check.value.test(firstLineValue(lines, s))) report(s, 'error', check.message);
  }

  for (const s of itemsOf(statements, 'bgimage')) {
    for (const p of backgroundProblems(lines, s, imageExists)) report(s, p.severity, p.message);
  }

  for (const kind of KINDS) {
    const items = itemsOf(statements, kind);
    const indexed = items.filter(s => s.index !== undefined);
    const declared = new Set(indexed.map(s => s.index));
    // Lines without an index may be what a number refers to, so it can't be called missing
    const canBeMissing = indexed.length === items.length;

    // Same index twice. button(3) + pushbutton(3) is only reported as a mix
    const byName = new Map<string, Statement[]>();
    for (const s of indexed) {
      const name = `${s.keyword}(${s.index})`;
      byName.set(name, [...(byName.get(name) ?? []), s]);
    }
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      for (const s of same) {
        report(s, 'error', `${describe(s)} is declared more than once (lines ${same.map(x => x.startLine + 1).join(', ')})`);
      }
    }

    // Lists and triggers that refer to items that don't exist
    for (const s of statements) {
      const missing = canBeMissing ? [...new Set(references(s, kind))].filter(n => n > 0 && !declared.has(n)) : [];
      if (!missing.length) continue;
      if (s.keyword === 'group') {
        report(s, 'error', `Field(s) ${missing.join(', ')} referenced in group but not declared`);
      } else {
        report(s, 'warning', `${s.keyword} refers to ${kind}(s) that are not declared: ${missing.join(', ')}`);
      }
    }

    // Items on no tab, once the form has any tab list of that kind
    const onTabs = new Set(statements.filter(s => optListKind(s.keyword) === kind).flatMap(s => references(s, kind)));
    // Backgrounds are normally on every tab
    if (onTabs.size && kind !== 'bgimage') {
      for (const s of indexed) {
        if (onTabs.has(s.index!)) continue;
        const pos = itemPosition(lines, s);
        const hidden = pos && (pos.row === 1000 || pos.col === 1000);
        const bottomBar = kind === 'button' && pos?.row === 100;
        // In a list view, a column on no opt_field list is on every page, as intended
        // and its heading goes with it
        const everyPageColumn = (kind === 'field' || kind === 'text') && columnIndexes.has(s.index!);
        if (!hidden && !bottomBar && !everyPageColumn) {
          report(s, 'info', `${describe(s)} is declared but not assigned to any tab using opt_${s.keyword}`);
        }
      }
    }
  }

  const fields = itemsOf(statements, 'field');
  const groups = statements.filter(s => s.keyword === 'group' && s.valueStart >= 0);
  if (fields.length && !groups.length) {
    report(fields[0], 'info', 'Fields declared but no corresponding group statement found');
  } else {
    const grouped = new Set(groups.flatMap(s => references(s, 'field')));
    for (const s of fields) {
      if (s.index !== undefined && !grouped.has(s.index)) {
        report(s, 'error', `${describe(s)} is declared but not referenced in any group`);
      }
    }
  }

  listviewProblems(lines, statements, report);

  if (buttonSpellings(statements).mixed) {
    for (const s of statements) {
      if (s.valueStart < 0 || (s.keyword !== 'pushbutton' && s.keyword !== 'opt_pushbutton')) continue;
      report(s, 'warning', 'A form can not use both button and pushbutton. Convert all pushbuttons to buttons.', MIXED_BUTTONS);
    }
  }

  return problems.sort((a, b) => a.startLine - b.startLine);
}

/** Field type has +4096. */
function isExoField(lines: string[], s: Statement): boolean {
  const m = firstLineValue(lines, s).match(/^\s*(?:"[^"]*"|<[^>]*>|\S+)\s+([\d+]+)/);
  return !!m && (flagValue(m[1]) & EXO_FIELD) !== 0;
}

/** page_listview(page)= srow scol nrow ncol mode: five numbers, a page that exists, each page once. */
function listviewProblems(lines: string[], statements: Statement[], report: (s: Statement, severity: Problem['severity'], message: string) => void): void {
  const listviews = statements.filter(s => s.keyword === 'page_listview' && s.valueStart >= 0);
  if (!listviews.length) return;
  const pages = new Set(statements.filter(s => s.keyword === 'page_header' && s.index !== undefined).map(s => s.index));
  const byPage = new Map<number, Statement[]>();
  for (const s of listviews) {
    const values = listTokens(lines, s).map(t => t.text);
    // The mode is a sum of bits, e.g. 1+2
    if (values.length !== 5 || !values.slice(0, 4).every(v => /^\d+$/.test(v)) || !/^\d+(\+\d+)*$/.test(values[4])) {
      report(s, 'error', 'page_listview needs 5 numbers: srow scol nrow ncol mode');
    }
    if (s.index === undefined) {
      report(s, 'error', 'page_listview needs a page number: page_listview(0) for every page, or the index of a page_header');
      continue;
    }
    if (s.index !== 0 && !pages.has(s.index)) {
      report(s, 'warning', `page_listview(${s.index}) is for a page that does not exist: there is no page_header(${s.index}). Use 0 for every page.`);
    }
    byPage.set(s.index, [...(byPage.get(s.index) ?? []), s]);
  }
  for (const same of byPage.values()) {
    if (same.length < 2) continue;
    for (const s of same) {
      report(s, 'error', `Page_listview(${s.index}) is declared more than once (lines ${same.map(x => x.startLine + 1).join(', ')})`);
    }
  }
}
