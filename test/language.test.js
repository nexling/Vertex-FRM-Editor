const test = require('node:test');
const assert = require('node:assert/strict');
const { renumberItems, convertPushbuttons } = require('../out/renumber.js');
const { findProblems } = require('../out/diagnostics.js');
const { completionsAt, keywordAt } = require('../out/keywordContext.js');
const { newButtonKeyword } = require('../out/frmStatements.js');

const L = s => s.split('\n');
const renumber = (s, kind, ranges) => {
  const r = renumberItems(L(s), kind, ranges);
  if (r.error) throw new Error(r.error);
  return r.lines.join('\n');
};
const problems = s => findProblems(L(s)).map(p => `${p.startLine + 1} ${p.severity} ${p.message}`);

test('renumber updates all field references and keeps order and layout', () => {
  assert.equal(renumber(
    `revision= 2
field(5)= "A" 1 1 1 5 7
  field(3) =  B 1 2 1 5 7 ;! field(5)
group(1)= 0 1 5   5 3 0 ;! 3 5
opt_field(1)= 3 \\
   5
tab_order= 3 5
trigger= 5 x.prg p
trigger= 0 all.prg p
trigger= $ONSTART2 y.prg p`, 'field'),
    `revision= 2
field(1)= "A" 1 1 1 5 7
  field(2) =  B 1 2 1 5 7 ;! field(5)
group(1)= 0 1 5   1 2 0 ;! 3 5
opt_field(1)= 2 \\
   1
tab_order= 2 1
trigger= 1 x.prg p
trigger= 0 all.prg p
trigger= $ONSTART2 y.prg p`);
});

test('without revision 2 the group has two fixed values', () => {
  assert.equal(renumber('field(3)= A 1 1 1 5 7\ngroup(1)= 1+2 3 3', 'field'), 'field(1)= A 1 1 1 5 7\ngroup(1)= 1+2 3 1');
});

test('renumber gives unindexed lines a number', () => {
  assert.equal(renumber('text= 1 1 "a"\ntext(1)= 2 1 "b"\ntext()= 3 1 "c"\nopt_text(1)= 1', 'text'),
    'text(1)= 1 1 "a"\ntext(2)= 2 1 "b"\ntext(3)= 3 1 "c"\nopt_text(1)= 2');
});

test('a selection starts at its lowest index and skips used ones', () => {
  assert.equal(renumber('text(1)= 1 1 "a"\ntext(6)= 2 1 "b"\ntext(4)= 3 1 "c"\ntext(5)= 4 1 "d"', 'text', [{ start: 1, end: 2 }]),
    'text(1)= 1 1 "a"\ntext(4)= 2 1 "b"\ntext(6)= 3 1 "c"\ntext(5)= 4 1 "d"');
  assert.match(renumberItems(L('text(1)= 1 1 "a"\n!'), 'text', [{ start: 1, end: 1 }]).error, /selection/);
});

test('referenced duplicates stop renumbering; unreferenced ones do not', () => {
  assert.match(renumberItems(L('field(5)= A 1 1 1 5 7\nfield(5)= B 1 2 1 5 7\ngroup(1)= 1 1 5'), 'field').error, /lines 1, 2/);
  assert.equal(renumber('text(5)= 1 1 "a"\ntext(5)= 2 1 "b"', 'text'), 'text(1)= 1 1 "a"\ntext(2)= 2 1 "b"');
});

test('renumber works on pushbutton-only forms without converting', () => {
  assert.equal(renumber('pushbutton(9)= 1 1 "a"\nopt_pushbutton(1)= 9', 'button'), 'pushbutton(1)= 1 1 "a"\nopt_pushbutton(1)= 1');
});

test('convert moves clashing pushbuttons and merges lists', () => {
  const r = convertPushbuttons(L(`button(3)= 1 1 "a"
pushbutton(3)= 2 1 "b"
pushbutton(4)= 3 1 "c"
opt_button(1)= 3 \\
  4
opt_pushbutton(1)= 3 4
opt_pushbutton(2)= 3 ;! second
field(1)= A 1 1 1 5 7`));
  assert.equal(r.lines.join('\n'), `button(3)= 1 1 "a"
button(5)= 2 1 "b"
button(4)= 3 1 "c"
opt_button(1)= 3 \\
  4 5
opt_button(2)= 5 ;! second
field(1)= A 1 1 1 5 7`);
  assert.equal(r.newLine(7), 6);
});

test('convert: one list spelling, numbers stay with the same-named element or the only one there is', () => {
  assert.equal(convertPushbuttons(L('button(1)= 1 1 "a"\npushbutton(1)= 2 1 "b"\npushbutton(2)= 2 1 "c"\nopt_button(1)= 1 2')).lines.join('\n'),
    'button(1)= 1 1 "a"\nbutton(3)= 2 1 "b"\nbutton(2)= 2 1 "c"\nopt_button(1)= 1 2');
  assert.equal(convertPushbuttons(L('button(1)= 1 1 "a"\nopt_pushbutton(1)= 1')).lines.join('\n'), 'button(1)= 1 1 "a"\nopt_button(1)= 1');
});

test('new button spelling', () => {
  assert.equal(newButtonKeyword(['']), 'button');
  assert.equal(newButtonKeyword(['pushbutton(1)= 1 1 "a"']), 'pushbutton');
  assert.equal(newButtonKeyword(['pushbutton(1)= 1 1 "a"', 'button(2)= 1 1 "a"']), 'button');
});

test('group check looks at all groups together and ignores comments', () => {
  assert.deepEqual(problems('field(1)= A 1 1 1 5 7\nfield(2)= B 1 1 1 5 7\ngroup(1)= 1 1 1 ;! 9\ngroup(2)= 1 1 2'), []);
  assert.deepEqual(problems('field(1)= A 1 1 1 5 7\nfield(2)= B 1 1 1 5 7\ngroup(1)= 1 1 1 9'), [
    '2 error Field(2) is declared but not referenced in any group',
    '3 error Field(s) 9 referenced in group but not declared',
  ]);
  assert.deepEqual(problems('! c\nfield(1)= A 1 1 1 5 7'), ['2 info Fields declared but no corresponding group statement found']);
});

test('tab check', () => {
  assert.deepEqual(problems(`text(1)= 1 1 "a"
text(2)= 1 1 "b"
text(3)= 1000 1000 "hidden"
text(4)= 1 1 "d"
button(1)= 2 2 "x"
button(2)= 100 0 0 {OK} $OK2
button(3)= 2 2 "y"
opt_text(1)= 1 \\
  4
opt_button(1)= 1`), [
    '2 info Text(2) is declared but not assigned to any tab using opt_text',
    '7 info Button(3) is declared but not assigned to any tab using opt_button',
  ]);
  assert.deepEqual(problems('field(1)= "A" 1 1000 5 5 7\nfield(2)= "B" 1 1 5 5 7\ngroup(1)= 1 1 1 2\nopt_field(1)= 2'), []);
});

test('duplicates and missing references', () => {
  assert.deepEqual(problems('text(1)= 1 1 "a"\ntext(1)= 1 2 "b"\nopt_text(1)= 1 7\ntrigger= 4 x.prg p\ntrigger= $ONEXIT1 x.prg p\ntrigger= 0 x.prg p\ntab_order= 2'), [
    '1 error Text(1) is declared more than once (lines 1, 2)',
    '2 error Text(1) is declared more than once (lines 1, 2)',
    '3 warning opt_text refers to text(s) that are not declared: 7',
    '4 warning trigger refers to field(s) that are not declared: 4',
    '7 warning tab_order refers to field(s) that are not declared: 2',
  ]);
});

test('mixed buttons', () => {
  const p = findProblems(L('button(3)= 1 1 "a"\npushbutton(3)= 2 1 "b"'));
  assert.deepEqual(p.map(x => [x.startLine, x.severity, x.code]), [[1, 'warning', 'mixed-buttons']]);
  assert.equal(findProblems(L('button(1)= 1 1 "a"\nopt_pushbutton(1)= 1')).length, 1);
  assert.deepEqual(problems('pushbutton(3)= 2 1 "b"\nopt_pushbutton(1)= 3'), []);
});

test('header checks', () => {
  assert.deepEqual(problems('port_size= 1\nheader= x\nvxdbase_winstyle= VXUI\ntext_font = 5\nfield_font 5').map(x => x.split(' ').slice(0, 3).join(' ')),
    ['1 error port_size', '2 error header', '5 error field_font']);
});

test('completion and hover only where keywords can stand', () => {
  assert.ok(completionsAt('  tex', 5).some(k => k.label === 'text'));
  assert.deepEqual(completionsAt('text(1)= 1 1 "te', 16), []);
  assert.deepEqual(completionsAt('! te', 4), []);
  assert.deepEqual(completionsAt('te', 2, 'group(1)= 1 1 \\'), []);
  assert.deepEqual(completionsAt('button(1)= 1 1 {X} R', 20).map(k => k.label), ['CHECKBOX', 'RADIO']);
  assert.deepEqual(completionsAt('button(1)= 1 1 "R', 17), []);
  assert.deepEqual(completionsAt('button(1)= 1 1 "a" ;! R', 23), []);
  assert.equal(keywordAt('text(1)= 1 1 "text"', 0, 'text').label, 'text');
  assert.equal(keywordAt('text(1)= 1 1 "text"', 14, 'text'), undefined);
});
