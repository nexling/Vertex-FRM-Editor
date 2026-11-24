// What a button line does after its label: RADIO / CHECKBOX / NAME=value. No VS Code dependency.

export interface ButtonAssignment {
  kind: 'radio' | 'checkbox' | 'select';
  /** The variable as written, with any leading `$`. Undefined if the line names none. */
  name?: string;
  /** '' when the button sets the variable to blank. */
  value?: string;
}

const NAME_VALUE = '(\\$?[A-Z0-9_]+)\\s*=\\s*(\\S*)';

/** The value after `=`; DEFAULT or a comment there means the value is blank. */
function valueOf(token: string): string {
  return /^!|^DEFAULT$/i.test(token) ? '' : token.replace(/,/g, ';');
}

/** Parse the part of a button line after its label. Undefined when it sets no variable. */
export function parseButtonAssignment(tail: string): ButtonAssignment | undefined {
  for (const kind of ['radio', 'checkbox'] as const) {
    if (!new RegExp(`\\b${kind}\\b`, 'i').test(tail)) continue;
    const m = tail.match(new RegExp(`\\b${kind}\\b\\s*${NAME_VALUE}`, 'i'));
    return m ? { kind, name: m[1], value: valueOf(m[2]) } : { kind };
  }
  const m = tail.match(new RegExp(NAME_VALUE, 'i'));
  if (!m) return undefined;
  const value = valueOf(m[2]);
  // A blank assignment must be all the button does, so a program call's "(X= )" is not taken for one
  if (value === '' && tail.slice(0, m.index).trim()) return undefined;
  return { kind: 'select', name: m[1], value };
}
