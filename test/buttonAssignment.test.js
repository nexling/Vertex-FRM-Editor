const test = require('node:test');
const assert = require('node:assert/strict');
const { parseButtonAssignment } = require('../out/buttonAssignment.js');

const parse = (tail, kind, name, value) => assert.deepEqual(parseButtonAssignment(tail), { kind, name, value });

test('blank values', () => {
  parse('RADIO MOUNT=', 'radio', 'MOUNT', '');
  parse('RADIO MOUNT= DEFAULT', 'radio', 'MOUNT', '');
  parse('RADIO MOUNT= !comment', 'radio', 'MOUNT', '');
  parse('CHECKBOX MOUNT=', 'checkbox', 'MOUNT', '');
  parse('MOUNT=', 'select', 'MOUNT', '');
  parse('MOUNT= ! none', 'select', 'MOUNT', '');
});

test('values', () => {
  parse('RADIO MOUNT= 1', 'radio', 'MOUNT', '1');
  parse('RADIO MOUNT=1 DEFAULT', 'radio', 'MOUNT', '1');
  parse('CHECKBOX ON=1,0', 'checkbox', 'ON', '1;0');
  parse('MOUNT=1', 'select', 'MOUNT', '1');
});

test('names keep their case and $', () => {
  parse('RADIO $Mount=1', 'radio', '$Mount', '1');
  parse('$MOUNT=', 'select', '$MOUNT', '');
});

test('no assignment', () => {
  assert.equal(parseButtonAssignment(''), undefined);
  assert.equal(parseButtonAssignment('@go P'), undefined);
  assert.equal(parseButtonAssignment('@go ! X='), undefined);
  assert.deepEqual(parseButtonAssignment('RADIO'), { kind: 'radio' });
});
