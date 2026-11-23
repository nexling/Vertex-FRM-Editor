// Decides where keyword completion and hover apply. No VS Code dependency.
import { lineContinues } from './elementLookup';
import { trailingCommentStart } from './frmStatements';
import { FrmKeyword, keywords } from './keywords';

const BUTTON_KINDS = ['RADIO', 'CHECKBOX'];
const BUTTON_LINE = /^\s*(?:push)?button\s*(?:\(\s*\d*\s*\))?\s*=/i;

const buttonKeywords = keywords.filter(k => BUTTON_KINDS.includes(k.label));
const statementKeywords = keywords.filter(k => !BUTTON_KINDS.includes(k.label));

function inLabel(before: string): boolean {
  const outsideQuotes = before.replace(/"[^"]*"/g, '');
  return outsideQuotes.includes('"') || outsideQuotes.lastIndexOf('{') > outsideQuotes.lastIndexOf('}');
}

function isContinuation(previousLine: string | undefined): boolean {
  return previousLine !== undefined && !/^\s*!/.test(previousLine) && lineContinues(previousLine);
}

/** True where RADIO / CHECKBOX can stand: a button line's value, outside its label and comment. */
function atButtonKind(line: string, column: number): boolean {
  return BUTTON_LINE.test(line.slice(0, column)) && column <= trailingCommentStart(line) && !inLabel(line.slice(0, column));
}

/** Keywords to offer at a position. */
export function completionsAt(line: string, column: number, previousLine?: string): FrmKeyword[] {
  if (isContinuation(previousLine)) return [];
  if (/^\s*\w*$/.test(line.slice(0, column))) return statementKeywords;
  return atButtonKind(line, column) ? buttonKeywords : [];
}

/** The keyword whose help to show for the word starting at `column`. */
export function keywordAt(line: string, column: number, word: string, previousLine?: string): FrmKeyword | undefined {
  if (isContinuation(previousLine)) return undefined;
  if (/^\s*$/.test(line.slice(0, column))) {
    return statementKeywords.find(k => k.label.toLowerCase() === word.toLowerCase());
  }
  return atButtonKind(line, column) ? buttonKeywords.find(k => k.label === word.toUpperCase()) : undefined;
}

/** Help text: the examples, then the description. */
export function keywordHelp(k: FrmKeyword): string {
  return `${k.documentation}\n\n---\n${k.detail}`;
}
