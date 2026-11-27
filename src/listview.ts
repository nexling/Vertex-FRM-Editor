// List view forms (page_listview): which table each tab shows and which fields are its columns.
// No VS Code dependency.

/** page_listview(page)= srow scol nrow ncol mode */
export interface Listview {
  page: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  mode: number;
  modeExpr: string;
}

/** What the column rules need to know about a field. */
export interface ColumnSource {
  index?: number;
  col: number;
  /** Field type +4096: drawn as a control, never a column. */
  exo: boolean;
}

/** Field type bit that makes a field an exo field (outside the database). */
export const EXO_FIELD = 4096;
/** group(1) type bit: the list has no column headers. */
export const NO_COLUMN_HEADERS = 1024;

const LISTVIEW = /^\s*page_listview\s*\(\s*(\d+)\s*\)\s*=\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:[ \t]+([\d+]+))?/gim;

/** Sum of a `1+2+4096` style expression; bits are OR-ed so a repeated bit counts once. */
export function flagValue(expr: string): number {
  return expr.split('+').map(s => Number(s.trim())).filter(n => Number.isFinite(n)).reduce((a, b) => a | b, 0);
}

/** Every page_listview statement, in file order. The mode may be left out (it then counts as 0). */
export function parseListviews(text: string): Listview[] {
  const found: Listview[] = [];
  for (const m of text.matchAll(LISTVIEW)) {
    const modeExpr = m[6] ?? '0';
    found.push({
      page: Number(m[1]), row: Number(m[2]), col: Number(m[3]), rows: Number(m[4]), cols: Number(m[5]),
      mode: flagValue(modeExpr), modeExpr,
    });
  }
  return found;
}

/** filter_row= mode, or undefined when the form doesn't set it. */
export function parseFilterRow(text: string): number | undefined {
  const m = text.match(/^\s*filter_row\s*=\s*(\d+)/im);
  return m ? Number(m[1]) : undefined;
}

/** True when group(1)'s type has the "no column headers" bit. */
export function hasNoColumnHeaders(text: string): boolean {
  const m = text.match(/^\s*group\s*\(\s*1\s*\)\s*=\s*([\d+]+)/im);
  return !!m && (flagValue(m[1]) & NO_COLUMN_HEADERS) !== 0;
}

/**
 * The tabs each listview is drawn on, by page. Tab n shows page_listview(n), else (0), else none.
 * Without tabs the form shows (0), or the lowest page when there is no (0); that one gets 'all'.
 * The first statement of a page wins when a page is defined twice.
 */
export function listviewTabs(listviews: Listview[], tabIds: number[]): Map<number, number[] | 'all'> {
  const pages = new Set(listviews.map(l => l.page));
  const result = new Map<number, number[] | 'all'>();
  if (!pages.size) return result;
  if (!tabIds.length) {
    result.set(pages.has(0) ? 0 : Math.min(...pages), 'all');
    return result;
  }
  for (const id of tabIds) {
    const page = pages.has(id) ? id : pages.has(0) ? 0 : undefined;
    if (page === undefined) continue;
    const on = result.get(page);
    result.set(page, [...(Array.isArray(on) ? on : []), id]);
  }
  return result;
}

/**
 * Columns of a tab's table, as positions in `fields`. Exo fields are never columns.
 * First the fields shown on every tab (on no opt_field list), by start column and then index;
 * then the fields of opt_field(tabId) in listed order. Without tabs (tabId undefined): every
 * non-exo field in the first order.
 */
export function columnOrder(fields: ColumnSource[], tabFields?: Record<number, number[]>, tabId?: number): number[] {
  const listed = new Set(tabId === undefined ? [] : Object.values(tabFields ?? {}).flat());
  const isColumn = (f: ColumnSource) => !f.exo;
  const common = fields
    .map((f, pos) => ({ f, pos }))
    .filter(({ f }) => isColumn(f) && !(f.index !== undefined && listed.has(f.index)))
    .sort((a, b) => (a.f.col - b.f.col) || ((a.f.index ?? Infinity) - (b.f.index ?? Infinity)) || (a.pos - b.pos))
    .map(({ pos }) => pos);
  if (tabId === undefined) return common;
  const out = [...common];
  for (const index of tabFields?.[tabId] ?? []) {
    const pos = fields.findIndex(f => f.index === index && isColumn(f));
    if (pos >= 0 && !out.includes(pos)) out.push(pos);
  }
  return out;
}
