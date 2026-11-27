const test = require('node:test');
const assert = require('node:assert/strict');
const { addElement } = require('../out/elementEdits.js');
const { setElementProp } = require('../out/elementProps.js');

const L = s => s.split('\n');
const add = (form, msg, winstyle) => addElement(L(form), { row: 2, col: 3, ...msg }, winstyle);

test('an image is added in its section and on the active tab', () => {
  const { lines, key } = add('text(1)= 1 1 "A"\nimage(3)= 1 1 2 2 0 "a.png"\nopt_text(1)= 1',
    { elementType: 'image', rows: 4, cols: 5, mode: '1+2', file: 'b "x.png', activeTabId: 1 });
  assert.equal(key, 'image:4');
  assert.deepEqual(lines.slice(2), ['image(4)= 2 3 4 5 1+2 "b x.png"', 'opt_text(1)= 1', 'opt_image(1)= 4']);
});

test('a preview is added to the active tab', () => {
  const { lines } = add('preview(1)= 1 1 2 2 0 "p" "" PORT_2D SIMPLE\nopt_preview(2)= 1',
    { elementType: 'preview', path: 'q', rows: 3, cols: 4, portStyle: '', activeTabId: 2 });
  assert.deepEqual(lines.slice(1), ['preview(2)= 2 3 3 4 0 "q" "" PORT_2D ""', 'opt_preview(2)= 1 2']);
});

test('a field joins group(1) and gets the window style default', () => {
  const { lines } = add('revision= 2\nfield(1)= A 1 1 1 4 7\ngroup(1)= 0 1 0 1',
    { elementType: 'field', name: 'B', nameFormat: { angle: true, quoted: true }, len: 6, values: ['x', 'y'] }, 'ONLY');
  assert.deepEqual(lines.slice(2), ['field(2)= "<B>" 1 2 3 6 4 "x" "y"', 'group(1)= 0 1 0 1 2']);
});

test('buttons follow the spelling of the form, texts and radios their own format', () => {
  assert.equal(add('pushbutton(1)= 1 1 "A"', { elementType: 'pushbutton', label: 'L', program: 'go' }).lines[1], 'pushbutton(2)= 2 3 "L" @go P');
  assert.ok(add('header= "x"', { elementType: 'pushbutton', label: 'L', kind: 'radio', name: 'V', value: '' }).lines.includes('button(1)= 2 3 "L" RADIO V='));
  assert.ok(add('header= "x"', { elementType: 'text', content: 'Hi' }).lines.includes('text(1)= 2 3 "Hi"'));
});

test('an element without a known type or position is refused', () => {
  assert.equal(add('', { elementType: 'group' }), undefined);
  assert.equal(add('', { elementType: 'text', row: 0 }), undefined);
});

test('a new element gets defaults for what the message leaves out', () => {
  // Added from the toolbox: the Properties panel fills in the rest
  assert.ok(add('field(1)= A 1 1 1 4 7\ngroup(1)= 0 1 1', { elementType: 'field' }).lines.includes('field(2)= FIELD2 1 2 3 10 7'));
  assert.ok(add('', { elementType: 'image', file: ' " ' }).lines.includes('image(1)= 2 3 10 20 0 ""'));
  assert.ok(add('', { elementType: 'image', rows: 4, cols: 6 }).lines.includes('image(1)= 2 3 4 6 0 ""'));
  assert.ok(add('', { elementType: 'preview', rows: 5, cols: 20 }).lines.includes('preview(1)= 2 3 5 20 0 "" "" PORT_2D SIMPLE'));
});

const setImage = (line, key, value) => setElementProp(L(line), { type: 'image', index: 1 }, key, value)?.join('\n');

test('changing an image changes only what is asked', () => {
  const line = ' image( 1 ) =  8  2  4   10  1+x  {a.png}  ! note';
  assert.equal(setImage(line, 'rows', '6'), ' image( 1 ) =  8  2  6   10  1+x  {a.png}  ! note');
  assert.equal(setImage(line, 'file', 'b $&.png'), ' image( 1 ) =  8  2  4   10  1+x  {b $&.png}  ! note');
  assert.equal(setImage(line, 'rows', '-1'), undefined);
  assert.equal(setImage('image(1)= 1 1 2 2 0 {"a.png"}', 'file', 'b.png'), 'image(1)= 1 1 2 2 0 {"b.png"}');
  assert.equal(setImage('image(1)= 1 1 2 2 0 ! note', 'file', 'b.png'), 'image(1)= 1 1 2 2 0 "b.png" ! note');
  assert.equal(setImage('image(1)= 1 1 2 2 0 ""', 'file', 'b.png'), 'image(1)= 1 1 2 2 0 "b.png"');
  assert.equal(setImage('image(2)= 1 1 2 2 0 "a.png"', 'rows', '3'), undefined);
});

test('changing an image keeps continuation lines', () => {
  assert.equal(setImage('image(1)= 1 1 2 2 \\\n   0 "a.png"', 'file', 'b.png'), 'image(1)= 1 1 2 2 \\\n   0 "b.png"');
});
