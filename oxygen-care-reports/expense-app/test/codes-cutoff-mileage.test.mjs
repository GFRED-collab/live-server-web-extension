import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mfaTestEnv, signIn } from './sign-in-helper.mjs';

const serverFile = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server.mjs');

async function startServer(t, settings) {
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-expenses-codes-'));
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(join(directory, 'data', 'settings.json'), JSON.stringify(settings));
  const port = 32000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverFile], {
    cwd: directory,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SUPERUSER_EMAIL: 'admin@example.test',
      SUPERUSER_PASSWORD: 'AdminPassword123!',
      ...mfaTestEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => (errors += chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 5000);
    child.once('exit', code => reject(new Error(`Server exited with ${code}: ${errors}`)));
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Expense app running')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  t.after(async () => {
    if (child.exitCode === null)
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, directory };
}

function client(base) {
  return async (path, { cookie = '', method = 'GET', body } = {}) => {
    const csrf = /(?:^|;\s*)oc_csrf=([^;]+)/.exec(cookie)?.[1];
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };
}

// The server works in Irish time.
const irishDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
const today = irishDate();
const thisMonth = today.slice(0, 7);
const lastMonth = (() => {
  const [year, month] = thisMonth.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
})();

test('employee codes, category codes and renames, cut-off date and engine-size mileage', async t => {
  // Older settings had a single mileage rate: it becomes the starting rate for every band.
  const { base, directory } = await startServer(t, {
    categories: ['Travel', 'Other'],
    departments: ['Engineering'],
    mileageRate: 0.3
  });
  const call = client(base);
  const admin = (await signIn(base, 'admin@example.test', 'AdminPassword123!')).cookie;
  const settings = (await call('/api/settings', { cookie: admin })).body;
  assert.deepEqual(settings.mileageRates, {
    upTo1200: 0.3,
    from1201To1500: 0.3,
    over1500: 0.3,
    electric: 0.3
  });
  assert.deepEqual(
    settings.engineBands.map(band => band.key),
    ['upTo1200', 'from1201To1500', 'over1500', 'electric']
  );

  // 1. Employee codes: stored in capitals, validated and unique.
  const newUser = (email, extra = {}) =>
    call('/api/users', {
      cookie: admin,
      method: 'POST',
      body: {
        email,
        password: 'EmployeePass123!',
        fullName: email.split('@')[0],
        role: 'regular',
        department: 'Engineering',
        jobDescription: '',
        carRegistration: '',
        mileageEnabled: true,
        ...extra
      }
    });
  const created = await newUser('staff@example.test', { employeeCode: ' e1024 ' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const staffUser = created.body.user;
  assert.equal(staffUser.employeeCode, 'E1024');
  assert.equal(staffUser.engineBand, '');
  assert.equal((await newUser('dup@example.test', { employeeCode: 'E1024' })).status, 409);
  assert.equal((await newUser('bad@example.test', { employeeCode: 'E 10/24' })).status, 400);
  assert.equal((await newUser('band@example.test', { engineBand: 'diesel' })).status, 400);
  const edit = body =>
    call(`/api/users/${staffUser.id}`, {
      cookie: admin,
      method: 'PATCH',
      body: {
        fullName: 'Staff Member',
        department: 'Engineering',
        jobDescription: '',
        carRegistration: '',
        ...body
      }
    });
  assert.equal((await edit({ employeeCode: 'E2048' })).body.user.employeeCode, 'E2048');
  // Leaving the code out keeps it.
  assert.equal((await edit({})).body.user.employeeCode, 'E2048');

  // 2. Category codes: optional, exactly six digits, unique.
  const addCategory = body =>
    call('/api/settings/categories', { cookie: admin, method: 'POST', body });
  assert.equal((await addCategory({ name: 'Training', code: '41020' })).status, 400);
  const added = await addCategory({ name: 'Training', code: '410200' });
  assert.equal(added.status, 201);
  assert.equal(added.body.categoryCodes.Training, '410200');
  assert.equal((await addCategory({ name: 'Parking', code: '410200' })).status, 409);

  // 3. Mileage by engine size.
  let staff = (await signIn(base, 'staff@example.test', 'EmployeePass123!')).cookie;
  const claim = month =>
    call('/api/mileage/month', {
      cookie: staff,
      method: 'POST',
      body: { month, kilometres: 100 }
    });
  const noBand = await claim(thisMonth);
  assert.equal(noBand.status, 400);
  assert.match(noBand.body.error, /engine size/);
  const rates = { upTo1200: 0.2, from1201To1500: 0.3, over1500: 0.4, electric: 0.25 };
  assert.equal(
    (
      await call('/api/settings/categories', {
        cookie: admin,
        method: 'POST',
        body: { mileageRates: { ...rates, electric: -1 } }
      })
    ).status,
    400
  );
  const saved = await call('/api/settings/categories', {
    cookie: admin,
    method: 'POST',
    body: { mileageRates: rates }
  });
  assert.deepEqual(saved.body.mileageRates, rates);
  await edit({ engineBand: 'electric' });
  // A Super User's change to a profile signs that person out.
  staff = (await signIn(base, 'staff@example.test', 'EmployeePass123!')).cookie;
  const month = await call(`/api/mileage/month?month=${thisMonth}`, { cookie: staff });
  assert.equal(month.body.mileageRate, 0.25);
  assert.equal(month.body.engineBandLabel, 'Electric');
  const mileage = await claim(thisMonth);
  assert.equal(mileage.status, 201, JSON.stringify(mileage.body));
  assert.equal(mileage.body.expense.amount, 25);
  assert.equal(mileage.body.expense.mileageRate, 0.25);
  assert.equal(mileage.body.expense.engineBand, 'electric');

  // 4. Renaming a category carries its expenses and code with it; required ones keep their name.
  const addExpense = (date, category = 'Training') =>
    call('/api/expenses', {
      cookie: staff,
      method: 'POST',
      body: {
        merchant: `Course ${date}`,
        amount: 50,
        currency: 'EUR',
        category,
        date,
        note: ''
      }
    });
  const lastMonthExpense = await addExpense(`${lastMonth}-15`);
  assert.equal(lastMonthExpense.status, 201, JSON.stringify(lastMonthExpense.body));
  assert.equal(lastMonthExpense.body.expense.categoryCode, '410200');
  const renamed = await call('/api/settings/categories', {
    cookie: admin,
    method: 'PATCH',
    body: { name: 'Training', newName: 'Training & Courses', code: '410300' }
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.ok(renamed.body.categories.includes('Training & Courses'));
  assert.ok(!renamed.body.categories.includes('Training'));
  assert.deepEqual(renamed.body.categoryCodes, { 'Training & Courses': '410300' });
  const stored = JSON.parse(await readFile(join(directory, 'data', 'expenses.json'), 'utf8'));
  assert.equal(
    stored.find(expense => expense.id === lastMonthExpense.body.expense.id).category,
    'Training & Courses'
  );
  assert.equal(
    (
      await call('/api/settings/categories', {
        cookie: admin,
        method: 'PATCH',
        body: { name: 'Mileage Expense', newName: 'Car' }
      })
    ).status,
    409
  );
  assert.equal(
    (
      await call('/api/settings/categories', {
        cookie: admin,
        method: 'PATCH',
        body: { name: 'Travel', newName: 'Training & Courses' }
      })
    ).status,
    409,
    'two categories cannot share a name'
  );
  // Reports carry the employee code and the category code.
  const report = await call('/api/reports/expenses', { cookie: admin });
  const row = report.body.expenses.find(expense => expense.id === lastMonthExpense.body.expense.id);
  assert.equal(row.user.employeeCode, 'E2048');
  assert.equal(row.categoryCode, '410300');

  // 5. The cut-off date: only a Super User sets it, never in the future.
  const cutoff = date =>
    call('/api/settings/cutoff', { cookie: admin, method: 'PUT', body: { date } });
  assert.equal(
    (await call('/api/settings/cutoff', { cookie: staff, method: 'PUT', body: { date: today } }))
      .status,
    403
  );
  assert.equal((await cutoff('2999-01-01')).status, 400);
  assert.equal((await cutoff(`${thisMonth}-01`)).body.expenseCutoffDate, `${thisMonth}-01`);
  // Before the cut-off: new claims, deletions and last month's mileage are refused.
  const late = await addExpense(`${lastMonth}-20`, 'Travel');
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'period_closed');
  assert.match(late.body.error, /are closed/);
  const removeLate = await call(`/api/expenses/${lastMonthExpense.body.expense.id}`, {
    cookie: staff,
    method: 'DELETE'
  });
  assert.equal(removeLate.status, 409);
  assert.equal((await claim(lastMonth)).body.code, 'period_closed');
  const listed = (await call('/api/expenses', { cookie: staff })).body.expenses;
  assert.equal(
    listed.find(expense => expense.id === lastMonthExpense.body.expense.id).closed,
    true
  );
  // On or after the cut-off date claims carry on as normal.
  const current = await addExpense(today, 'Travel');
  assert.equal(current.status, 201, JSON.stringify(current.body));
  assert.equal(current.body.expense.closed, false);
  // A cut-off later in the month closes this month's earlier days for editing too.
  if (today.slice(8) !== '01') {
    const earlier = await addExpense(`${thisMonth}-01`, 'Travel');
    assert.equal(earlier.status, 201);
    await cutoff(today);
    const change = await call(`/api/expenses/${earlier.body.expense.id}`, {
      cookie: staff,
      method: 'PUT',
      body: { ...earlier.body.expense, amount: 60, date: `${thisMonth}-01` }
    });
    assert.equal(change.status, 409);
    assert.equal(change.body.code, 'period_closed');
  }
  // Clearing the cut-off opens every date again.
  assert.equal((await cutoff('')).body.expenseCutoffDate, '');
  assert.equal((await addExpense(`${lastMonth}-20`, 'Travel')).status, 201);
});
