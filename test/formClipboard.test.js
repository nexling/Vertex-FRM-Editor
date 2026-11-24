const test = require('node:test');
const assert = require('node:assert/strict');
const { copyStatements, deleteStatements, pasteStatements, validTriggerRefs } = require('../out/formClipboard.js');
const { addFieldToGroup1 } = require('../out/elementEdits.js');

const L = s => s.split('\n');
const SIZE = { rows: 20, cols: 60 };
const FORM = `revision= 2
text(1)=  2  4 {TYPE}
field(1)=  "A"   1+2  2 16 16 7 0 \\
  "path:x"
field(2)= B 1 1000 1000 4 7
button(1)= 6 2 {GO}  @go
group(1)= 0 1 0 1 2
opt_text(1)= 1
opt_field(1)= 1 2
tab_order= 1 2
trigger= 1 run.prg p
trigger= $ONSTART2 start.prg p`;

test('copies statements verbatim in file order', () => {
  const { text, count } = copyStatements(L(FORM), [{ type: 'field', index: 1 }, { type: 'text', index: 1 }],
    [{ line: 10, target: '1', program: 'run.prg' }]);
  assert.equal(count, 3);
  assert.equal(text, 'text(1)=  2  4 {TYPE}\nfield(1)=  "A"   1+2  2 16 16 7 0 \\\n  "path:x"\ntrigger= 1 run.prg p\n');
});

test('a trigger is found when its line has moved, and not when it is another one', () => {
  const t = { line: 0, target: '$ONSTART2', program: 'start.prg' };
  assert.equal(copyStatements(L(FORM), [], [t]).text, 'trigger= $ONSTART2 start.prg p\n');
  assert.equal(copyStatements(L(FORM), [], [{ ...t, program: 'x.prg' }]).count, 0);
  assert.deepEqual(validTriggerRefs([t, null, { line: 'x' }]), [t]);
});

test('cut and paste in the same form restores indexes, group, tab and triggers', () => {
  const refs = [{ type: 'text', index: 1 }, { type: 'field', index: 1 }];
  const triggers = [{ line: 10, target: '1', program: 'run.prg' }];
  const { text } = copyStatements(L(FORM), refs, triggers);
  const cut = deleteStatements(L(FORM), refs, triggers);
  assert.equal(cut.deleted.length, 2);
  assert.equal(cut.deletedTriggers, 1);
  const r = pasteStatements(cut.lines, text, { ...SIZE, tabId: 1, sameForm: true, restoreIndexes: true, cell: { row: 5, col: 6 } });
  assert.deepEqual(r.keys, ['text:1', 'field:1']);
  const out = r.lines.join('\n');
  assert.match(out, /text\(1\)= {2}5 {2}6 \{TYPE\}/);
  assert.match(out, /field\(1\)= {2}"A" {3}1\+2 {2}5 18 16 7 0 \\\n {2}"path:x"/);
  assert.match(out, /group\(1\)= 0 1 0 1 2\n/);
  assert.match(out, /opt_text\(1\)= 1\n/);
  assert.match(out, /opt_field\(1\)= 1 2\n/);
  assert.match(out, /trigger= 1 run\.prg p$/);
  // A second paste finds them taken
  const again = pasteStatements(r.lines, text, { ...SIZE, tabId: 1, sameForm: true, restoreIndexes: true, cell: { row: 8, col: 6 } });
  assert.deepEqual(again.keys, ['text:2', 'field:3']);
  assert.ok(again.lines.includes('trigger= 3 run.prg p'));
  assert.deepEqual(again.triggerLines.map(i => again.lines[i]), ['trigger= 3 run.prg p']);
});

test('paste uses the next free indexes, the form\'s button keyword and the active tab', () => {
  const r = pasteStatements(L('pushbutton(3)= 1 1 {X} @x\nopt_text(2)= 5'), FORM, { ...SIZE, tabId: 2, cell: { row: 1, col: 1 } });
  const out = r.lines.join('\n');
  assert.deepEqual(r.keys, ['text:1', 'field:1', 'pushbutton:4']);
  assert.deepEqual(r.hiddenFields, [2]);
  assert.match(out, /^pushbutton\(4\)= 5 1 \{GO\} {2}@go$/m);
  assert.match(out, /^field\(2\)= B 1 1000 1000 4 7$/m);
  assert.match(out, /^opt_text\(2\)= 1 5$/m);
  assert.match(out, /^opt_field\(2\)= 1 2$/m);
  assert.match(out, /^opt_pushbutton\(2\)= 4$/m);
  assert.equal(r.skipped, 5);
  assert.equal(r.triggerLines.length, 2);
});

test('the group stays inside the form', () => {
  const sizeOf = () => ({ rows: 1, cols: 10 });
  const text = 'text(1)= 1 1 {A}\ntext(2)= 3 5 {B}';
  const at = (rows, cols, cell) => {
    const r = pasteStatements([], text, { rows, cols, cell, sizeOf });
    return [r.lines.filter(l => /^text/.test(l)), r.tooBig];
  };
  assert.deepEqual(at(10, 20, { row: 10, col: 20 }), [['text(1)= 8 7 {A}', 'text(2)= 10 11 {B}'], false]);
  assert.deepEqual(at(2, 20, { row: 2, col: 2 }), [['text(1)= 1 2 {A}', 'text(2)= 3 6 {B}'], true]);
});

test('without a cell the positions are kept, one row down at a time while taken', () => {
  const form = L('text(1)= 2 4 {A}\ntext(2)= 3 4 {A}\nfield(1)= A 1 4 4 4 7');
  const paste = (lines, rows) => pasteStatements(lines, 'text(1)= 2 4 {A}', { rows, cols: 60 }).lines;
  assert.ok(paste(form, 20).includes('text(3)= 4 4 {A}'));
  assert.ok(paste([], 20).includes('text(1)= 2 4 {A}'));
  assert.ok(paste(form, 3).includes('text(3)= 2 4 {A}')); // nowhere free
});

test('trigger targets in another form', () => {
  const text = 'trigger= 1 a.prg p\ntrigger= 9 b.prg p\ntrigger= 0 c.prg p\ntrigger=  1  have.prg p';
  const form = L('field(1)= A 1 2 2 4 7\ntrigger= 1 have.prg p');
  const r = pasteStatements(form, text, SIZE);
  assert.deepEqual(r.lines.slice(1), ['trigger= 1 have.prg p', 'trigger= 1 a.prg p', 'trigger= 0 c.prg p']);
  assert.deepEqual([r.keptTargets, r.missingTargets, r.duplicateTriggers], [['1'], ['9'], 1]);
  // In the same form an index is never questioned
  assert.ok(pasteStatements(form, text, { ...SIZE, sameForm: true }).lines.includes('trigger= 9 b.prg p'));
});

test('other text is skipped', () => {
  assert.equal(pasteStatements(['a'], 'hello\n! text(1)= 1 1 {A}\ntext= 1 1 {A}', SIZE), undefined);
  const r = pasteStatements(['text(1)= 1 1 {X}'], '! note\r\nbutton(1)= 100 1 0 {OK}\r\ntext(7)= 2 2 {A} \\', SIZE);
  assert.deepEqual(r.lines, ['text(1)= 1 1 {X}', 'text(2)= 2 2 {A}']);
  assert.equal(r.skipped, 2);
});

test('group(1) keeps both leading values without revision 2', () => {
  const lines = ['group(1)= 1+2 7 1 3'];
  addFieldToGroup1(lines, 2, undefined);
  addFieldToGroup1(lines, 7, 1);
  assert.deepEqual(lines, ['group(1)= 1+2 7 1 2 3 7']);
});
