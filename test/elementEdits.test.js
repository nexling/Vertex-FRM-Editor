const test = require('node:test');
const assert = require('node:assert/strict');
const { moveElements, deleteElements, duplicateElements, validRefs, isMove } = require('../out/elementEdits.js');

const L = s => s.split('\n');
const FORM = `revision= 2
text(1)=  2  4 {TYPE}
field(1)=  "A"   1+2  2 16 16 7 0 "path:x"
field(2)= <B> 1 3 16 4 7 ! note
field(3)= C 1 4 16 4 7
pushbutton(1)= 6 2 {GO}  @go
image(1)= 8 2 4 10 0 "a.png"
group(1)= 0 1 0 1 2 3
opt_field(1)= 1 2 \\
                3
opt_field(2)= 2
opt_button(1)= 1
tab_order= 1 2 3`;

test('move changes only the positions of the named elements', () => {
  const { lines, failed } = moveElements(L(FORM), [
    { type: 'text', index: 1, row: 4, col: 4 },
    { type: 'field', index: 1, row: 4, col: 16 },
    { type: 'field', index: 2, row: 5, col: 17 },
    { type: 'pushbutton', index: 1, row: 8, col: 3 },
    { type: 'image', index: 1, row: 9, col: 1 }
  ]);
  assert.deepEqual(failed, []);
  const before = L(FORM);
  const changed = lines.filter((l, i) => l !== before[i]);
  assert.deepEqual(changed, [
    'text(1)=  4 4 {TYPE}',
    'field(1)=  "A"   1+2  4 16 16 7 0 "path:x"',
    'field(2)= <B> 1 5 17 4 7 ! note',
    'pushbutton(1)= 8 3 {GO}  @go',
    'image(1)= 9 1 4 10 0 "a.png"'
  ]);
});

test('elements that swap places keep their own line', () => {
  const { lines } = moveElements(L(FORM), [
    { type: 'field', index: 2, row: 4, col: 16 }, { type: 'field', index: 3, row: 3, col: 16 }
  ]);
  assert.equal(lines[3], 'field(2)= <B> 1 4 16 4 7 ! note');
  assert.equal(lines[4], 'field(3)= C 1 3 16 4 7');
});

test('a missing element is reported and the others still move', () => {
  const { lines, failed } = moveElements(L(FORM), [
    { type: 'field', index: 9, row: 1, col: 1 }, { type: 'field', index: 3, row: 9, col: 9 }
  ]);
  assert.deepEqual(failed.map(f => f.index), [9]);
  assert.equal(lines[4], 'field(3)= C 1 9 9 4 7');
});

test('delete removes the elements from the group and the tabs', () => {
  const { lines, deleted } = deleteElements(L(FORM), [
    { type: 'field', index: 2 }, { type: 'field', index: 3 }, { type: 'pushbutton', index: 1 }, { type: 'text', index: 7 }
  ]);
  assert.equal(deleted.length, 3);
  assert.equal(lines.join('\n'), `revision= 2
text(1)=  2  4 {TYPE}
field(1)=  "A"   1+2  2 16 16 7 0 "path:x"
image(1)= 8 2 4 10 0 "a.png"
group(1)= 0 1 0 1
opt_field(1)= 1
tab_order= 1 2 3`);
});

test('delete removes continuation lines', () => {
  const { lines } = deleteElements(L('text(1)= 1 1 {A} \\\n  + {B}\ntext(2)= 2 2 {C}'), [{ type: 'text', index: 1 }]);
  assert.deepEqual(lines, ['text(2)= 2 2 {C}']);
});

test('duplicate gives each copy its own index, row, group entry and tabs', () => {
  const { lines, copies } = duplicateElements(L(FORM), [
    { type: 'field', index: 3, row: 7 }, { type: 'field', index: 2, row: 6 }, { type: 'pushbutton', index: 1, row: 9 }
  ]);
  assert.deepEqual([...copies], [['field:2', 'field:4'], ['field:3', 'field:5'], ['pushbutton:1', 'pushbutton:2']]);
  assert.equal(lines.join('\n'), `revision= 2
text(1)=  2  4 {TYPE}
field(1)=  "A"   1+2  2 16 16 7 0 "path:x"
field(2)= <B> 1 3 16 4 7 ! note
field(3)= C 1 4 16 4 7
field(4)= <B> 1 6 16 4 7 ! note
field(5)= C 1 7 16 4 7
pushbutton(1)= 6 2 {GO}  @go
pushbutton(2)= 9 2 {GO}  @go
image(1)= 8 2 4 10 0 "a.png"
group(1)= 0 1 0 1 2 3 4 5
opt_field(1)= 1 2\\
                3 4\\
                5
opt_field(2)= 2 4
opt_button(1)= 1 2
tab_order= 1 2 3`);
});

test('malformed and repeated elements in a message are left out', () => {
  assert.deepEqual(validRefs([
    { type: 'field', index: 1, row: 1, col: 1 }, { type: 'field', index: 1, row: 2, col: 2 },
    { type: 'group', index: 1, row: 1, col: 1 }, { type: 'text', index: 1, row: 0, col: 1 },
    { type: 'text', index: null, row: 1, col: 1 }, null
  ], isMove), [{ type: 'field', index: 1, row: 1, col: 1 }]);
  assert.deepEqual(validRefs(undefined), []);
});
