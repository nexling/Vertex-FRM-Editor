const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseListviews, parseFilterRow, hasNoColumnHeaders, listviewTabs, columnOrder, flagValue
} = require('../out/listview.js');
const { findProblems } = require('../out/diagnostics.js');
const { elementsInSelections, findElement, findElementStatements } = require('../out/elementLookup.js');
const { moveElements, validRefs, deleteElements } = require('../out/elementEdits.js');
const { keywordAt } = require('../out/keywordContext.js');

const L = s => s.split('\n');
const problems = s => findProblems(L(s)).map(p => `${p.startLine + 1} ${p.severity} ${p.message}`);
const fixture = fs.readFileSync(path.join(__dirname, '..', 'test-list-form.frm'), 'utf8');

test('page_listview values, filter_row and the no-headers bit', () => {
  assert.deepEqual(parseListviews('page_listview(2)= 4 1 11 110 1+2\npage_listview( 0 ) =1 1 14 140'), [
    { page: 2, row: 4, col: 1, rows: 11, cols: 110, mode: 3, modeExpr: '1+2' },
    { page: 0, row: 1, col: 1, rows: 14, cols: 140, mode: 0, modeExpr: '0' },
  ]);
  assert.equal(parseFilterRow('filter_row= 0'), 0);
  assert.equal(parseFilterRow('header= "x"'), undefined);
  assert.equal(hasNoColumnHeaders('group(1)= 1+2+1024 2 0 1 2'), true);
  assert.equal(hasNoColumnHeaders('group(1)= 1+2 2 0 1024'), false);
  assert.equal(hasNoColumnHeaders('group(2)= 1024 2 0 1'), false);
  assert.equal(flagValue('1+4096'), 4097);
});

test('which table each tab shows', () => {
  const lv = pages => pages.map(page => ({ page }));
  const tabs = (pages, ids) => Object.fromEntries(listviewTabs(lv(pages), ids));
  // Own table, else the (0) table
  assert.deepEqual(tabs([0, 2], [1, 2, 3]), { 0: [1, 3], 2: [2] });
  // No (0): tabs without their own table show none
  assert.deepEqual(tabs([2], [1, 2]), { 2: [2] });
  // A page without a tab is not drawn
  assert.deepEqual(tabs([0, 7], [1]), { 0: [1] });
  // No tabs: (0), else the lowest page
  assert.deepEqual(tabs([3, 0], []), { 0: 'all' });
  assert.deepEqual(tabs([5, 3], []), { 3: 'all' });
  assert.deepEqual(tabs([], [1]), {});
});

test('columns: every-tab fields by start column then index, then the tab\'s opt_field order; exo fields never', () => {
  const fields = [
    { index: 1, col: 0, exo: false },
    { index: 2, col: 5, exo: false },
    { index: 3, col: 0, exo: false },
    { index: 4, col: 1000, exo: false }, // parked: still a column
    { index: 5, col: 0, exo: false },
    { index: 6, col: 0, exo: false },
    { index: 20, col: 13, exo: true },
  ];
  const opt = { 2: [6, 5, 20, 99], 3: [5] };
  const idx = positions => positions.map(p => fields[p].index);
  assert.deepEqual(idx(columnOrder(fields)), [1, 3, 5, 6, 2, 4]);
  assert.deepEqual(idx(columnOrder(fields, opt, 1)), [1, 3, 2, 4]);
  assert.deepEqual(idx(columnOrder(fields, opt, 2)), [1, 3, 2, 4, 6, 5]);
  assert.deepEqual(idx(columnOrder(fields, opt, 3)), [1, 3, 2, 4, 5]);
});

test('page_listview diagnostics', () => {
  assert.deepEqual(problems(`page_header(1)= "A"
page_listview(0)= 1 1 14 140 0
page_listview(1)= 1 1 14 140 1+2
page_listview(3)= 1 1 14 140 0
page_listview(1)= 1 1 14
page_listview= 1 1 14 140 0
page_listview(0)= 1 1 14 140 x`), [
    '2 error Page_listview(0) is declared more than once (lines 2, 7)',
    '3 error Page_listview(1) is declared more than once (lines 3, 5)',
    '4 warning page_listview(3) is for a page that does not exist: there is no page_header(3). Use 0 for every page.',
    '5 error page_listview needs 5 numbers: srow scol nrow ncol mode',
    '5 error Page_listview(1) is declared more than once (lines 3, 5)',
    '6 error page_listview needs a page number: page_listview(0) for every page, or the index of a page_header',
    '7 error page_listview needs 5 numbers: srow scol nrow ncol mode',
    '7 error Page_listview(0) is declared more than once (lines 2, 7)',
  ]);
});

test('list view: columns and their headings on no tab list are not reported; exo fields still are', () => {
  const form = `page_header(1)= "A"
page_listview(0)= 1 1 14 140 0
text(1)= 0 0 "Name"
text(2)= 2 1 "Exo"
field(1)= NAME 1 0 0 20 7 0
field(2)= "$X" 1+4096 2 10 20 0 0
group(1)= 0 1 1 2
opt_field(1)= 9
opt_text(1)= 9`;
  assert.deepEqual(problems(form).filter(p => /assigned/.test(p)), [
    '4 info Text(2) is declared but not assigned to any tab using opt_text',
    '6 info Field(2) is declared but not assigned to any tab using opt_field',
  ]);
});

test('the fixture has no problems', () => {
  assert.deepEqual(problems(fixture), []);
});

test('the table is found, moved and deleted like an element, but is not copied or pasted', () => {
  const lines = L(fixture);
  const at = findElement(lines, 'listview', 2);
  assert.match(lines[at.startLine], /^page_listview\(2\)= 4 1 11 110 1\+2$/);
  assert.equal(findElementStatements(lines).some(s => s.type === 'listview'), false);

  const sel = elementsInSelections(lines, [{ startLine: at.startLine, endLine: at.startLine, endCharacter: 0, activeLine: at.startLine }]);
  assert.deepEqual(sel.keys, ['listview:2']);
  assert.equal(sel.primary, 'listview:2');

  const moved = moveElements(lines, [{ type: 'listview', index: 2, row: 6, col: 3 }]);
  assert.deepEqual(moved.failed, []);
  assert.equal(moved.lines[at.startLine], 'page_listview(2)= 6 3 11 110 1+2');

  const deleted = deleteElements(lines, [{ type: 'listview', index: 0 }]);
  assert.equal(deleted.deleted.length, 1);
  assert.equal(deleted.lines.some(l => /^page_listview\(0\)/.test(l)), false);

  const ref = [{ type: 'listview', index: 0 }];
  assert.deepEqual(validRefs(ref), []);
  assert.deepEqual(validRefs(ref, undefined, true), ref);
});

test('hover for the list keywords', () => {
  for (const word of ['page_listview', 'filter_row', 'autofit_mode', 'sort_mode', 'sort_order', 'start_page']) {
    assert.equal(keywordAt(`${word}= 1`, 0, word)?.label, word);
  }
});
