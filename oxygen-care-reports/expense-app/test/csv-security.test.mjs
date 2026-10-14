import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/csv.js', import.meta.url), 'utf8'), context);
const cell = context.window.oxygenCsvCell;
test('CSV exports neutralise formula-like untrusted strings', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '  =1+1', '\ttext', '\rtext', '\ntext', '＝1+1']) {
    assert.equal(cell(value), '"' + "'" + value.replaceAll('"', '""') + '"');
  }
  assert.equal(cell('a,"b"'), '"a,""b"""');
  assert.equal(cell('Ordinary note'), '"Ordinary note"');
  assert.equal(cell(12.5), '"12.5"');
  assert.equal(cell(-12.5), '"-12.5"');
  assert.equal(cell(null), '""');
});
test('all report CSV exporters use the shared safety helper', () => {
  const reports = readFileSync(new URL('../public/reports.html', import.meta.url), 'utf8');
  assert.equal((reports.match(/quote=window.oxygenCsvCell/g) || []).length, 3);
  assert.match(reports, /src="\/csv.js"/);
});
