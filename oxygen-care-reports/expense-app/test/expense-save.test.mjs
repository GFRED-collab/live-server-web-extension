import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('    let saving = false'), source.indexOf("    const saveButton = button('Save expense'"));
function setup({ refreshFails = false, uncertain = false, accept = true } = {}) {
  const calls = [], messages = [];
  let prompts = 0, writes = 0;
  const context = {
    form: { reportValidity: () => true }, saveButton: {},
    merchant: { value: 'Test' }, amount: { value: '12' }, category: { value: 'Other' },
    date: { value: '2026-09-25' }, note: { value: '' }, mode: { receipt: null },
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    editor: { classList: { add() {}, remove() {} } },
    status: { replaceChildren: (...args) => messages.push(...args) }, notice: x => x,
    confirm: () => { prompts++; return accept; },
    refreshHome: async () => { if (refreshFails) throw Error('Refresh failed'); },
    api: async (url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      await Promise.resolve();
      if (!body.confirmDuplicate) throw Object.assign(Error('Duplicate'), { code: 'possible_duplicate', status: 409 });
      writes++;
      if (uncertain && writes === 1) throw Error('Response lost');
      return { expense: { id: 'saved' } };
    }
  };
  const save = vm.runInNewContext(handler + '\nsaveExpense;', context);
  return { save, calls, messages, context, prompts: () => prompts };
}
test('overlapping clicks confirm and save only once', async () => {
  const s = setup();
  await Promise.all([s.save(), s.save(), s.save()]);
  await s.save();
  assert.equal(s.prompts(), 1);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].submissionId, s.calls[1].submissionId);
  assert.equal(s.context.saveButton.disabled, true);
});
test('refresh failure after saving cannot submit again', async () => {
  const s = setup({ refreshFails: true });
  await s.save(); await s.save();
  assert.equal(s.calls.length, 2);
  assert.match(s.messages.at(-1), /Expense saved.*could not refresh/);
});
test('uncertain response retries the same confirmed payload without another prompt', async () => {
  const s = setup({ uncertain: true });
  await s.save();
  s.context.amount.value = '99';
  await s.save();
  assert.equal(s.prompts(), 1);
  assert.deepEqual(s.calls[1], s.calls[2]);
});
test('declining confirmation does not save', async () => {
  const s = setup({ accept: false });
  await s.save();
  assert.equal(s.calls.length, 1);
  assert.equal(s.context.saveButton.disabled, false);
});
test('correcting a rejected date sends current details instead of stale submission', async () => {
  const s = setup();
  const payloads = [];
  s.context.api = async (url, options) => {
    payloads.push(JSON.parse(options.body));
    if (payloads.length === 1) throw Object.assign(Error('The date cannot be in the future.'), { status: 400, code: 'invalid_date' });
    return { expense: { id: 'saved' } };
  };
  s.context.date.value = '2099-10-10';
  await s.save();
  s.context.date.value = '2026-10-10';
  s.context.merchant.value = 'Corrected 😂';
  await s.save();
  assert.equal(payloads[1].date, '2026-10-10');
  assert.equal(payloads[1].merchant, 'Corrected 😂');
  assert.equal(s.context.saveButton.textContent, 'Saved');
});
