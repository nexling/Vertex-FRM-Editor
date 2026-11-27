const test = require('node:test');
const assert = require('node:assert/strict');
const { readElementProps, setElementProp, setElementFlag, PROP_DEFS } = require('../out/elementProps.js');

const L = s => s.split('\n');
const FORM = `revision= 2
page_header(1)= "One"
page_header(2)= "Two"
text(1)=  2  4 {TYPE}    ! note
text(2)= 3 4 "Hello"
text(3)= 5 4 {"Boxed"+" #[3,20]*"}
field(1)=  "A"   1+2  2 16 16 7 "path:x"
field(2)= <B> 1 3 16 4.2 7 ! note
field(3)= C 4 4 16 4
button(1)= 6 2 {GO}  @go.prg(A) P
pushbutton(2)= 7 2 "Check" CHECKBOX CHK=1;0
button(3)= 100 1 0 "Bar"
image(1)= 8 2 4 10 0 "a.png"
preview(1)= 9 2 5 20 1+2 "$DIR_PICTS/a.vxp" "" PORT_2D SIMPLE
page_listview(1)= 3 2 10 40 0
bgimage(1)= 200 -1 220 64 FRAME TILED "bg.png"
group(1)= 0 1 0 1 2
group(2)= 0 1 0 3
opt_text(1)= 1 2 3
opt_field(1)= 1 2
opt_field(2)= 2 3
opt_button(1)= 1 2 3
opt_image(1)= 1
opt_image(2)= 1`;

/** The lines that differ from FORM after a change. */
function changed(lines) {
  assert.ok(lines, 'the change was refused');
  const before = L(FORM);
  if (lines.length !== before.length) return lines.filter(l => !before.includes(l));
  return lines.filter((l, i) => l !== before[i]);
}
const set = (type, index, key, value) => setElementProp(L(FORM), { type, index }, key, value);
const flag = (type, index, key, bit, on) => setElementFlag(L(FORM), { type, index }, key, bit, on);

test('reads every property as written', () => {
  const p = readElementProps(L(FORM));
  assert.deepEqual(p['text:1'].values, { row: '2', col: '4', content: '{TYPE}', boxRows: '', boxCols: '', tabs: '1' });
  assert.equal(p['text:2'].values.content, 'Hello');
  assert.deepEqual([p['text:3'].values.content, p['text:3'].values.boxRows, p['text:3'].values.boxCols], ['Boxed', '3', '20']);
  assert.deepEqual(p['field:1'].values, {
    name: 'A', nameAngle: '', nameQuoted: '1', type: '1+2', row: '2', col: '16', len: '16', ignore: '7',
    values: 'path:x', group: '1', tabs: '1'
  });
  assert.deepEqual([p['field:2'].values.name, p['field:2'].values.nameAngle, p['field:2'].values.len, p['field:2'].values.tabs], ['B', '1', '4.2', 'all']);
  assert.deepEqual([p['field:3'].values.ignore, p['field:3'].values.group, p['field:3'].values.tabs], ['', '2', '2']);
  assert.deepEqual(p['pushbutton:1'].values, {
    row: '6', col: '2', label: '{GO}', kind: 'select', action: 'program', program: '@go.prg(A)', variable: '', value: '', tabs: '1'
  });
  assert.deepEqual([p['pushbutton:2'].values.label, p['pushbutton:2'].values.kind, p['pushbutton:2'].values.variable, p['pushbutton:2'].values.value],
    ['Check', 'checkbox', 'CHK', '1;0']);
  assert.equal(p['pushbutton:3'].bottomBar, true);
  assert.equal(p['pushbutton:3'].values.row, undefined);
  assert.deepEqual(p['image:1'].values, { row: '8', col: '2', rows: '4', cols: '10', mode: '0', file: 'a.png', tabs: 'all' });
  assert.deepEqual(p['preview:1'].values, {
    row: '9', col: '2', rows: '5', cols: '20', mode: '1+2', path: '$DIR_PICTS/a.vxp', field: '', portType: 'PORT_2D', portStyle: 'SIMPLE', tabs: 'all'
  });
  assert.deepEqual(p['listview:1'].values, { row: '3', col: '2', rows: '10', cols: '40', mode: '0' });
  assert.deepEqual(p['bgimage:1'].values, {
    width: '200', height: '-1', transparency: '220', mode: '64', placement: 'FRAME', alignment: 'TILED', file: 'bg.png', tabs: 'all'
  });
});

test('a form without tabs has no tabs property', () => {
  const p = readElementProps(L('field(1)= A 1 2 3 4 7\ngroup(1)= 0 1 0 1'));
  assert.equal(p['field:1'].values.tabs, undefined);
  assert.equal(p['field:1'].values.group, '1');
});

test('row and column change only their own number', () => {
  assert.deepEqual(changed(set('text', 1, 'row', '9')), ['text(1)=  9  4 {TYPE}    ! note']);
  assert.deepEqual(changed(set('field', 1, 'col', '20')), ['field(1)=  "A"   1+2  2 20 16 7 "path:x"']);
  assert.deepEqual(changed(set('pushbutton', 2, 'row', '1000')), ['pushbutton(2)= 1000 2 "Check" CHECKBOX CHK=1;0']);
  assert.deepEqual(changed(set('listview', 1, 'rows', '12')), ['page_listview(1)= 3 2 12 40 0']);
  assert.equal(set('text', 1, 'row', '0'), undefined);
  assert.equal(set('text', 1, 'row', ''), undefined);
  assert.equal(set('text', 1, 'row', '1a'), undefined);
  assert.equal(set('text', 9, 'row', '3'), undefined);
  assert.equal(set('pushbutton', 3, 'row', '3'), undefined); // bottom bar
});

test('field name, its brackets and quotes', () => {
  assert.deepEqual(changed(set('field', 2, 'name', 'BB')), ['field(2)= <BB> 1 3 16 4.2 7 ! note']);
  assert.deepEqual(changed(set('field', 2, 'nameAngle', '')), ['field(2)= B 1 3 16 4.2 7 ! note']);
  assert.deepEqual(changed(set('field', 2, 'nameQuoted', '1')), ['field(2)= "<B>" 1 3 16 4.2 7 ! note']);
  assert.deepEqual(changed(set('field', 1, 'name', '$X')), ['field(1)=  "$X"   1+2  2 16 16 7 "path:x"']);
  assert.equal(set('field', 1, 'name', 'a b'), undefined);
  assert.equal(set('field', 1, 'name', ''), undefined);
});

test('field length, ignore value and dropdown values', () => {
  assert.deepEqual(changed(set('field', 2, 'len', '12')), ['field(2)= <B> 1 3 16 12 7 ! note']);
  assert.deepEqual(changed(set('field', 2, 'len', '30|3')), ['field(2)= <B> 1 3 16 30|3 7 ! note']);
  assert.equal(set('field', 2, 'len', 'x'), undefined);
  assert.equal(set('field', 2, 'len', '0'), undefined);
  assert.deepEqual(changed(set('field', 3, 'ignore', '4')), ['field(3)= C 4 4 16 4 4']);
  assert.deepEqual(changed(set('field', 3, 'values', 'a\n\n b \n')), ['field(3)= C 4 4 16 4 7 "a" "b"']);
  assert.deepEqual(changed(set('field', 1, 'values', '')), ['field(1)=  "A"   1+2  2 16 16 7']);
  assert.deepEqual(changed(set('field', 1, 'values', 'x\ny [2]*')), ['field(1)=  "A"   1+2  2 16 16 7 "x" "y [2]*"']);
  assert.deepEqual(changed(set('field', 2, 'values', 'v')), ['field(2)= <B> 1 3 16 4.2 7 "v" ! note']);
  // Numbers after the ignore value stay before the values
  const extra = L('field(1)= "DX" 5 4 16 4 7 0\nfield(2)= "T" 1+2 2 16 16 7 0 "path:x"');
  assert.deepEqual(setElementProp(extra, { type: 'field', index: 1 }, 'values', 'a')[0], 'field(1)= "DX" 5 4 16 4 7 0 "a"');
  assert.deepEqual(setElementProp(extra, { type: 'field', index: 2 }, 'values', 'y')[1], 'field(2)= "T" 1+2 2 16 16 7 0 "y"');
  assert.equal(readElementProps(extra)['field:2'].values.values, 'path:x');
});

test('flags keep the way they are written', () => {
  assert.deepEqual(changed(flag('field', 1, 'type', 4, true)), ['field(1)=  "A"   1+2+4  2 16 16 7 "path:x"']);
  assert.deepEqual(changed(flag('field', 1, 'type', 1, false)), ['field(1)=  "A"   2  2 16 16 7 "path:x"']);
  // A single bit counts as a sum of one; a plain number that isn't one bit stays a plain number
  assert.deepEqual(changed(flag('field', 3, 'type', 1, true)), ['field(3)= C 1+4 4 16 4']);
  assert.deepEqual(setElementFlag(L('field(1)= X 4101 1 1 4'), { type: 'field', index: 1 }, 'type', 2, true), ['field(1)= X 4103 1 1 4']);
  assert.deepEqual(setElementFlag(L('field(1)= X 2048+4+1 1 1 4'), { type: 'field', index: 1 }, 'type', 2, true), ['field(1)= X 2048+4+2+1 1 1 4']);
  assert.deepEqual(setElementFlag(L('field(1)= X 3+4 1 1 4'), { type: 'field', index: 1 }, 'type', 1, false), ['field(1)= X 2+4 1 1 4']);
  assert.deepEqual(changed(flag('field', 3, 'type', 4, false)), ['field(3)= C 0 4 16 4']);
  assert.deepEqual(changed(flag('image', 1, 'mode', 64, true)), ['image(1)= 8 2 4 10 64 "a.png"']);
  assert.deepEqual(changed(flag('preview', 1, 'mode', 1, false)), ['preview(1)= 9 2 5 20 2 "$DIR_PICTS/a.vxp" "" PORT_2D SIMPLE']);
  assert.deepEqual(changed(flag('preview', 1, 'mode', 2, false)), ['preview(1)= 9 2 5 20 1 "$DIR_PICTS/a.vxp" "" PORT_2D SIMPLE']);
  assert.deepEqual(changed(flag('bgimage', 1, 'mode', 128, true)), ['bgimage(1)= 200 -1 220 64+128 FRAME TILED "bg.png"']);
  // Already as asked: nothing changes
  assert.deepEqual(flag('field', 1, 'type', 2, true), L(FORM));
  assert.equal(flag('field', 1, 'type', 3, true), undefined);
});

test('text content and box', () => {
  assert.deepEqual(changed(set('text', 2, 'content', 'Bye "now"')), ['text(2)= 3 4 "Bye now"']);
  assert.deepEqual(changed(set('text', 1, 'content', '{OTHER}')), ['text(1)=  2  4 {OTHER}    ! note']);
  assert.deepEqual(changed(set('text', 1, 'content', 'Plain')), ['text(1)=  2  4 "Plain"    ! note']);
  assert.deepEqual(changed(set('text', 3, 'content', 'New')), ['text(3)= 5 4 {"New"+" #[3,20]*"}']);
  assert.deepEqual(changed(set('text', 3, 'boxRows', '')), ['text(3)= 5 4 {"Boxed"}']);
  assert.deepEqual(changed(set('text', 3, 'boxCols', '30')), ['text(3)= 5 4 {"Boxed"+" #[3,30]*"}']);
  assert.deepEqual(changed(set('text', 2, 'boxRows', '2')), ['text(2)= 3 4 {"Hello"+" #[2,20]*"}']);
  assert.equal(set('text', 2, 'boxRows', 'x'), undefined);
});

test('button label and action', () => {
  assert.deepEqual(changed(set('pushbutton', 1, 'label', 'Go on')), ['button(1)= 6 2 "Go on"  @go.prg(A) P']);
  assert.deepEqual(changed(set('pushbutton', 2, 'label', '{CHK_LBL}')), ['pushbutton(2)= 7 2 {CHK_LBL} CHECKBOX CHK=1;0']);
  assert.deepEqual(changed(set('pushbutton', 3, 'label', 'Close')), ['button(3)= 100 1 0 "Close"']);
  assert.deepEqual(changed(set('pushbutton', 1, 'program', 'other.prg')), ['button(1)= 6 2 {GO}  @other.prg P']);
  assert.deepEqual(changed(set('pushbutton', 2, 'kind', 'radio')), ['pushbutton(2)= 7 2 "Check" RADIO CHK=1;0']);
  assert.deepEqual(changed(set('pushbutton', 2, 'value', '')), ['pushbutton(2)= 7 2 "Check" CHECKBOX CHK=']);
  assert.deepEqual(changed(set('pushbutton', 1, 'action', 'variable')), ['button(1)= 6 2 {GO}  VAR=1']);
  assert.deepEqual(changed(set('pushbutton', 1, 'action', 'none')), ['button(1)= 6 2 {GO}']);
  assert.deepEqual(changed(set('pushbutton', 3, 'action', 'program')), ['button(3)= 100 1 0 "Bar" @program.prg P']);
  assert.equal(set('pushbutton', 2, 'variable', 'a b'), undefined);
});

test('image, preview and background values', () => {
  assert.deepEqual(changed(set('image', 1, 'file', 'b.png')), ['image(1)= 8 2 4 10 0 "b.png"']);
  assert.deepEqual(changed(set('image', 1, 'cols', '11')), ['image(1)= 8 2 4 11 0 "a.png"']);
  assert.deepEqual(changed(set('preview', 1, 'path', 'x.vxp')), ['preview(1)= 9 2 5 20 1+2 "x.vxp" "" PORT_2D SIMPLE']);
  assert.deepEqual(changed(set('preview', 1, 'field', 'F')), ['preview(1)= 9 2 5 20 1+2 "$DIR_PICTS/a.vxp" "F" PORT_2D SIMPLE']);
  assert.deepEqual(changed(set('preview', 1, 'portStyle', '')), ['preview(1)= 9 2 5 20 1+2 "$DIR_PICTS/a.vxp" "" PORT_2D ""']);
  assert.deepEqual(changed(set('preview', 1, 'portType', 'PORT_3D')), ['preview(1)= 9 2 5 20 1+2 "$DIR_PICTS/a.vxp" "" PORT_3D SIMPLE']);
  assert.equal(set('preview', 1, 'portType', 'PORT_X'), undefined);
  assert.deepEqual(changed(set('bgimage', 1, 'placement', 'DIALOG')), ['bgimage(1)= 200 -1 220 64 DIALOG TILED "bg.png"']);
  assert.deepEqual(changed(set('bgimage', 1, 'file', 'RGB(1,2,3)')), ['bgimage(1)= 200 -1 220 64 FRAME TILED "RGB(1,2,3)"']);
  assert.deepEqual(changed(set('bgimage', 1, 'width', '0')), ['bgimage(1)= 0 -1 220 64 FRAME TILED "bg.png"']);
  assert.equal(set('bgimage', 1, 'transparency', '256'), undefined);
});

test('tabs', () => {
  assert.deepEqual(changed(set('field', 3, 'tabs', 'all')), ['opt_field(1)= 1 2 3']);
  const moved = set('field', 1, 'tabs', '2');
  assert.ok(moved.includes('opt_field(1)= 2'));
  assert.ok(moved.includes('opt_field(2)= 1 2 3'));
  assert.equal(set('field', 1, 'tabs', ''), undefined);
  assert.equal(set('field', 1, 'tabs', '7'), undefined);
  // A background on every tab is named in no list
  const bg = set('bgimage', 1, 'tabs', '1');
  assert.ok(bg.includes('opt_bgimage(1)= 1'));
  assert.deepEqual(setElementProp(bg, { type: 'bgimage', index: 1 }, 'tabs', 'all'), L(FORM));
  assert.equal(readElementProps(bg)['bgimage:1'].values.tabs, '1');
});

test('group', () => {
  const g = set('field', 3, 'group', '1');
  assert.ok(g.includes('group(1)= 0 1 0 1 2 3'));
  assert.ok(!g.some(l => /^group\(2\)/.test(l)), 'an emptied group goes');
  const n = set('field', 1, 'group', '3');
  assert.ok(n.includes('group(1)= 0 1 0 2'));
  assert.equal(n[n.indexOf('group(2)= 0 1 0 3') + 1], 'group(3)= 0 1 0 1');
  assert.equal(readElementProps(n)['field:1'].values.group, '3');
  assert.equal(set('field', 1, 'group', '0'), undefined);
});

test('every property the panel shows has a definition', () => {
  const p = readElementProps(L(FORM));
  for (const key of Object.keys(p)) {
    const type = key.split(':')[0];
    const defined = PROP_DEFS[type].map(d => d.key);
    for (const prop of Object.keys(p[key].values)) assert.ok(defined.includes(prop), `${key} ${prop}`);
  }
});
