const test = require('node:test');
const assert = require('node:assert/strict');
const { findBackgrounds, imageCandidates, parseColor, addBackground, editBackground, validTabs } = require('../out/backgrounds.js');
const { duplicateElements, deleteElements, moveElements } = require('../out/elementEdits.js');
const { copyStatements, pasteStatements } = require('../out/formClipboard.js');
const { findProblems } = require('../out/diagnostics.js');

const L = s => s.split('\n');
const problems = (s, exists) => findProblems(L(s), exists).map(p => `${p.severity} ${p.message}`);

test('reads values, expressions, continuations and comments', () => {
  const [a, b, c] = findBackgrounds(L(
    `bgimage(1)= 200 -1 220  64+128  frame    BOTTOMRIGHT "$DIR_PROGRAMS/a b.png" ;! note
bgimage(2)= {W} 0 0 x \\
   DIALOG {A} {NAME+"x"}
! bgimage(9)= 1 1 1 1 FRAME TILED "x.png"
bgimage= 1 1 1 0 FRAME TILED {"x.png"}`));
  assert.deepEqual(a, { index: 1, width: 200, height: -1, transparency: 220, mode: 192, placement: 'FRAME', alignment: 'BOTTOMRIGHT', file: '$DIR_PROGRAMS/a b.png' });
  assert.deepEqual(b, { index: 2, width: null, height: 0, transparency: 0, mode: null, placement: 'DIALOG', alignment: null, file: null });
  assert.equal(c.index, undefined);
  assert.equal(c.file, 'x.png');
  assert.deepEqual(parseColor('rgb(1, 2,3)'), [1, 2, 3]);
  assert.equal(parseColor('RBG(1,2,3)'), undefined);
});

test('where files are looked for', () => {
  const bases = ['C:\\vx\\customA', 'C:/vx/system'];
  assert.deepEqual(imageCandidates('a.png', bases), ['C:/vx/customA/forms/images/a.png', 'C:/vx/system/forms/images/a.png']);
  assert.deepEqual(imageCandidates('$DIR_PICTS\\sub\\a.png', bases), ['C:/vx/customA/picts/sub/a.png', 'C:/vx/system/picts/sub/a.png']);
  assert.deepEqual(imageCandidates('D:\\x\\a.png', bases), ['D:/x/a.png']);
  assert.deepEqual(imageCandidates('\\\\server\\a.png', bases), []);
  assert.deepEqual(imageCandidates('$OTHER/a.png', bases), []);
});

test('problems', () => {
  assert.deepEqual(problems('bgimage(1)= -1 -1 0 64 FRAME TOPLEFT "a.png"', () => true), []);
  assert.deepEqual(problems('bgimage(1)= -1 -1 0 64 FRAME TOPLEFT "a.png"', () => undefined), []);
  assert.deepEqual(problems('bgimage(1)= {W} -1 0 {M} {P} {A} {F}', () => false), []);
  assert.deepEqual(problems('bgimage(1)= -1 -1 0 64 FRAME "a.png"'), ['error bgimage needs width, height, transparency, mode, placement, alignment, file; file missing']);
  assert.deepEqual(problems('bgimage(1)= a -1 300 b HERE THERE "RGB(1,2,256)"').length, 6);
  assert.match(problems('bgimage(1)= -1 -1 255 0 FRAME TOPLEFT "RGB(240,240,240)"')[0], /^info transparency 255/);
  assert.match(problems('bgimage(1)= -1 -1 0 0 FRAME TOPLEFT "RBG(1,1,1)"')[0], /^warning .*not RBG/);
  assert.match(problems('bgimage(1)= -1 -1 0 0 FRAME TOPLEFT "a.png"', () => false)[0], /^warning a.png not found/);
  assert.match(problems('bgimage(1)= -1 -1 0 0 FRAME TOPLEFT "a.svg"')[0], /^warning file type/);
  assert.match(problems('bgimage(1)= -1 -1 0 0 FRAME TOPLEFT "a.tif"')[0], /^info TIF/);
  // Being on every tab is normal
  assert.deepEqual(problems('bgimage(1)= 0 0 0 0 FRAME TILED "a.png"\nbgimage(2)= 0 0 0 0 FRAME TILED "a.png"\nopt_bgimage(1)= 1'), []);
});

const NEW = { width: -1, height: 50, transparency: 0, mode: 64, placement: 'FRAME', alignment: 'TOPLEFT', file: 'a.png' };

test('add goes after the backgrounds there are, else after the images', () => {
  const first = addBackground(L('text(1)= 1 1 "a"\nimage(1)= 1 1 1 1 0 "i.png"\npreview(1)= 1 1 1 1 0 "a" "" PORT_2D'), NEW);
  assert.equal(first.key, 'bgimage:1');
  assert.equal(first.lines[2], 'bgimage(1)= -1 50 0 64 FRAME TOPLEFT "a.png"');
  const second = addBackground(L('header= "x"\nbgimage(4)= 0 0 0 0 FRAME \\\n  TILED "a.png"\ntext(1)= 1 1 "a"'), NEW, [2]);
  assert.equal(second.lines[3], 'bgimage(5)= -1 50 0 64 FRAME TOPLEFT "a.png"');
  assert.ok(second.lines.includes('opt_bgimage(2)= 5'));
  assert.equal(addBackground([], { ...NEW, placement: 'X' }), undefined);
  assert.equal(addBackground([], { ...NEW, file: '""' }), undefined);
});

test('edit rewrites only the changed values', () => {
  const line = 'bgimage(1)=  200 {H} 220  64  "FRAME"    BOTTOMRIGHT {"a.png"} ;! note';
  assert.deepEqual(editBackground([line], 1, { width: 0, mode: 192, placement: 'DIALOG', file: 'RGB(1,2,3)' }),
    ['bgimage(1)=  0 {H} 220  64+128  "DIALOG"    BOTTOMRIGHT {"RGB(1,2,3)"} ;! note']);
  assert.deepEqual(editBackground(['bgimage(1)= 1 1 1 0 \\', '   FRAME TILED "a.png"'], 1, { alignment: 'MIDMID' }),
    ['bgimage(1)= 1 1 1 0 \\', '   FRAME MIDMID "a.png"']);
  assert.equal(editBackground([line], 2, { width: 0 }), undefined);
  assert.equal(editBackground([line], 1, { transparency: 256 }), undefined);
  assert.deepEqual(validTabs([1, 1, 2]), [1, 2]);
  assert.equal(validTabs([]), undefined);
});

test('edit tabs', () => {
  const form = L('bgimage(1)= 0 0 0 0 FRAME TILED "a.png"\nopt_bgimage(1)= 1 2\nopt_bgimage(2)= 1');
  assert.deepEqual(editBackground(form, 1, {}, 'all').slice(1), ['opt_bgimage(1)= 2']);
  assert.deepEqual(editBackground(form, 1, {}, [2, 3]).slice(1), ['opt_bgimage(1)= 2', 'opt_bgimage(2)= 1', 'opt_bgimage(3)= 1']);
});

test('duplicate, delete, move', () => {
  const form = L('bgimage(1)= 5 6 0 0 FRAME TILED "a.png"\ntext(1)= 1 1 "a"\nopt_bgimage(1)= 1');
  const d = duplicateElements(form, [{ type: 'bgimage', index: 1, row: 1 }]);
  assert.equal(d.lines[1], 'bgimage(2)= 5 6 0 0 FRAME TILED "a.png"');
  assert.equal(d.lines[3], 'opt_bgimage(1)= 1 2');
  assert.deepEqual(deleteElements(form, [{ type: 'bgimage', index: 1 }]).lines, ['text(1)= 1 1 "a"']);
  assert.equal(moveElements(form, [{ type: 'bgimage', index: 1, row: 9, col: 9 }]).failed.length, 1);
});

test('copy, paste and cut-paste', () => {
  const form = L('bgimage(3)= 5 6 0 0 FRAME TILED "a.png"\ntext(1)= 1 1 "a"');
  const { text, count } = copyStatements(form, [{ type: 'bgimage', index: 3 }], []);
  assert.equal(count, 1);
  const p = pasteStatements(form, text, { rows: 10, cols: 10, tabId: 1 });
  assert.deepEqual(p.keys, ['bgimage:4']);
  assert.equal(p.lines[1], 'bgimage(4)= 5 6 0 0 FRAME TILED "a.png"');
  assert.ok(!p.lines.some(l => /^opt_/.test(l)));
  assert.equal(p.skipped, 0);
  assert.deepEqual(pasteStatements(['text(1)= 1 1 "a"'], text, { rows: 10, cols: 10, restoreIndexes: true }).keys, ['bgimage:3']);
});
