// Finds which lines of an FRM file define which form element or trigger. No VS Code dependency.

export interface ElementStatement {
  /** Element type as the preview names it (`button` is reported as `pushbutton`). */
  type: string;
  index: number;
  startLine: number;
  /** Last line of the statement, including `\` continuations. */
  endLine: number;
}

/** A text selection: where it starts and ends, and the line the cursor blinks on. */
export interface LineSelection {
  startLine: number;
  endLine: number;
  endCharacter: number;
  activeLine: number;
}

export interface TriggerStatement {
  /** Field index, 0 for all fields, or a special target such as $ONSTART2. */
  target: string;
  line: number;
}

export interface ElementSelection {
  /** `type:index` of every touched element, in file order. */
  keys: string[];
  primary: string | null;
  triggers: TriggerStatement[];
  /** Line of the trigger at the main cursor, when that is a trigger rather than an element. */
  primaryTrigger: number | null;
}

const DEFINITION = /^\s*(text|field|pushbutton|button|image|preview)\s*\(\s*(\d+)\s*\)\s*=/i;
const TRIGGER = /^\s*trigger\s*=\s*(\$?\w+)/i;

/** True if a logical FRM statement continues onto the next line. */
export function lineContinues(line: string): boolean {
  return line.trimEnd().endsWith('\\');
}

function normalizeType(type: string): string {
  const t = type.toLowerCase();
  return t === 'button' ? 'pushbutton' : t;
}

/** First and last line of every statement. Comments are not statements. */
function statementRanges(lines: string[]): Array<{ startLine: number; endLine: number }> {
  const found: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const startLine = i;
    if (/^\s*!/.test(lines[i])) continue;
    while (i < lines.length - 1 && lineContinues(lines[i])) i++;
    found.push({ startLine, endLine: i });
  }
  return found;
}

/** Every indexed element definition in the file, in file order. */
export function findElementStatements(lines: string[]): ElementStatement[] {
  const found: ElementStatement[] = [];
  for (const range of statementRanges(lines)) {
    const m = lines[range.startLine].match(DEFINITION);
    if (m) found.push({ type: normalizeType(m[1]), index: Number(m[2]), ...range });
  }
  return found;
}

/** Every trigger in the file, in file order. */
export function findTriggerStatements(lines: string[]): Array<TriggerStatement & { startLine: number; endLine: number }> {
  return statementRanges(lines).flatMap(range => {
    const m = lines[range.startLine].match(TRIGGER);
    return m ? [{ target: m[1], line: range.startLine, ...range }] : [];
  });
}

/** The statement that defines an element (the first one, if it is defined twice). */
export function findElement(lines: string[], type: string, index: number): ElementStatement | undefined {
  const wanted = normalizeType(type);
  return findElementStatements(lines).find(s => s.type === wanted && s.index === Number(index));
}

/** The elements and triggers whose statements are touched by the selections; the first selection is the primary one. */
export function elementsInSelections(lines: string[], selections: LineSelection[]): ElementSelection {
  const statements = findElementStatements(lines);
  const keyOf = (s: ElementStatement) => `${s.type}:${s.index}`;
  const allTriggers = findTriggerStatements(lines);
  const touchedBy = <T extends { startLine: number; endLine: number }>(sel: LineSelection, among: T[]): T[] => {
    // A range ending at column 0 does not include that last line
    const last = sel.endCharacter === 0 && sel.endLine > sel.startLine ? sel.endLine - 1 : sel.endLine;
    return among.filter(s => s.startLine <= last && s.endLine >= sel.startLine);
  };

  const touched = new Set<ElementStatement>();
  selections.forEach(sel => touchedBy(sel, statements).forEach(s => touched.add(s)));
  const ordered = statements.filter(s => touched.has(s));
  const keys = [...new Set(ordered.map(keyOf))];

  // Primary: the element at the main cursor, else the nearest in its range, else the first in the file
  let primary: ElementStatement | undefined = ordered[0];
  let primaryTrigger: number | null = null;
  if (selections.length) {
    const line = selections[0].activeLine;
    const distance = (s: { startLine: number; endLine: number }) => Math.max(s.startLine - line, line - s.endLine, 0);
    const nearest = <T extends { startLine: number; endLine: number }>(among: T[]): T | undefined =>
      among.length ? among.reduce((best, s) => distance(s) < distance(best) ? s : best) : undefined;
    const element = nearest(touchedBy(selections[0], statements));
    const trigger = nearest(touchedBy(selections[0], allTriggers));
    if (element) primary = element;
    if (trigger && (!element || distance(trigger) < distance(element))) primaryTrigger = trigger.line;
  }
  const triggers = allTriggers.filter(t => selections.some(sel => touchedBy(sel, [t]).length > 0))
    .map(({ target, line }) => ({ target, line }));
  return { keys, primary: primary ? keyOf(primary) : null, triggers, primaryTrigger };
}
