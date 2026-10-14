import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function todayLocal('), end = source.indexOf('function publicExpense(', start);
const { todayLocal, dateValidationError } = vm.runInNewContext(source.slice(start, end) + ';({todayLocal,dateValidationError})');
test('Irish calendar date handles midnight independently of server timezone', () => {
  assert.equal(todayLocal(new Date('2026-10-09T23:28:00Z')), '2026-10-10');
  assert.equal(dateValidationError('2026-10-10', todayLocal(new Date('2026-10-09T23:28:00Z'))), '');
  assert.equal(todayLocal(new Date('2026-01-09T23:28:00Z')), '2026-01-09');
  assert.equal(todayLocal(new Date('2026-01-10T00:28:00Z')), '2026-01-10');
  assert.equal(todayLocal(new Date('2026-03-29T23:01:00Z')), '2026-03-30');
  assert.equal(todayLocal(new Date('2026-10-25T23:01:00Z')), '2026-10-25');
});
test('date errors distinguish future dates and malformed dates', () => {
  assert.match(dateValidationError('2026-10-11', '2026-10-10'), /future.*Ireland.*2026-10-10/);
  assert.match(dateValidationError('2026-02-30', '2026-10-10'), /valid date/);
  assert.match(dateValidationError('', '2026-10-10'), /valid date/);
  assert.match(dateValidationError(20261010, '2026-10-10'), /valid date/);
  assert.equal(dateValidationError('2024-02-29', '2026-10-10'), '');
});
