import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const serverFile = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server.mjs');

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-expenses-approvals-'));
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(
    join(directory, 'data', 'settings.json'),
    JSON.stringify({ categories: ['Other'], departments: ['Engineering', 'Sales'] })
  );
  const port = 32000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverFile], {
    cwd: directory,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SUPERUSER_EMAIL: 'admin@example.test',
      SUPERUSER_PASSWORD: 'AdminPassword123!'
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
  return `http://127.0.0.1:${port}`;
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
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
      headers: response.headers
    };
  };
}

// The server decides month ends in Irish time.
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Dublin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());
const [year, month] = today.split('-').map(Number);
const previousMonth =
  month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
const nextMonthStart =
  month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

test('approval rules, department odometer readings and the approvals dashboard', async t => {
  const base = await startServer(t);
  const call = client(base);
  const login = async (email, password) => {
    const response = await call('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200);
    const cookies = response.headers.get('set-cookie');
    return ['oc_session', 'oc_csrf']
      .map(name => `${name}=${new RegExp(`${name}=([^;,]+)`).exec(cookies)[1]}`)
      .join('; ');
  };
  const admin = await login('admin@example.test', 'AdminPassword123!');
  const person = async (email, role, department) => {
    const response = await call('/api/users', {
      method: 'POST',
      cookie: admin,
      body: {
        email,
        password: 'EmployeePass123!',
        fullName: email.split('@')[0],
        role,
        department,
        jobDescription: '',
        carRegistration: '',
        mileageEnabled: false
      }
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return login(email, 'EmployeePass123!');
  };
  const head = await person('head@example.test', 'department_head', 'Engineering');
  const staff = await person('staff@example.test', 'regular', 'Engineering');
  const sales = await person('sales@example.test', 'regular', 'Sales');
  const expense = async (cookie, date, amount) => {
    const response = await call('/api/expenses', {
      method: 'POST',
      cookie,
      body: {
        merchant: `Shop ${amount}`,
        amount,
        currency: 'EUR',
        category: 'Other',
        date,
        note: ''
      }
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.expense;
  };
  const ended = await expense(staff, `${previousMonth}-15`, 10);
  const current = await expense(staff, today, 20);
  const endedTwo = await expense(staff, `${previousMonth}-16`, 30);
  await expense(staff, today, 25);
  const review = (cookie, id, status, note = '') =>
    call(`/api/expenses/${id}`, { method: 'PATCH', cookie, body: { status, note } });

  // Listed expenses say when approval opens.
  const listed = (await call('/api/expenses', { cookie: staff })).body.expenses;
  const listedCurrent = listed.find(item => item.id === current.id);
  assert.equal(listedCurrent.approvalOpen, false);
  assert.equal(listedCurrent.approvalOpensOn, nextMonthStart);
  assert.equal(listed.find(item => item.id === ended.id).approvalOpen, true);

  // 4. Department Heads approve only once the month has ended; questions are still allowed.
  const early = await review(head, current.id, 'approved');
  assert.equal(early.status, 409);
  assert.match(early.body.error, new RegExp(nextMonthStart));
  assert.equal((await review(head, current.id, 'question', 'Which client?')).status, 200);
  const earlyBatch = await call('/api/expenses/batch-approve', {
    method: 'POST',
    cookie: head,
    body: { expenseIds: [endedTwo.id, current.id] }
  });
  assert.equal(earlyBatch.status, 409);
  assert.match(earlyBatch.body.error, /Nothing was approved/);
  assert.equal((await review(head, ended.id, 'approved')).status, 200);

  // 1. Approved expenses are locked against further review.
  const relook = await review(head, ended.id, 'declined', 'Changed my mind');
  assert.equal(relook.status, 409);
  assert.match(relook.body.error, /already approved/);
  assert.equal((await review(admin, ended.id, 'question', 'Check')).status, 409);

  // Super Users are not limited by the month end.
  const superCurrent = await expense(staff, today, 40);
  assert.equal((await review(admin, superCurrent.id, 'approved')).status, 200);

  // 2. Department Heads see their department's odometer readings, not other departments'.
  const reading = (cookie, opening) =>
    call('/api/odometer/month', {
      method: 'POST',
      cookie,
      body: { month: previousMonth, car1OpeningReading: opening, car1ClosingReading: opening + 100 }
    });
  assert.equal((await reading(staff, 1000)).status, 201);
  assert.equal((await reading(sales, 5000)).status, 201);
  const headReadings = await call('/api/reports/odometer', { cookie: head });
  assert.equal(headReadings.status, 200);
  assert.deepEqual(
    headReadings.body.readings.map(item => item.user.email),
    ['staff@example.test']
  );
  assert.equal(headReadings.body.readings[0].kilometres, 100);
  assert.equal((await call('/api/reports/odometer', { cookie: staff })).status, 403);
  assert.equal((await call('/api/reports/odometer', { cookie: admin })).body.readings.length, 2);

  // 5. The Super User dashboard counts due, not yet due and approved awaiting reimbursement.
  assert.equal((await call('/api/dashboard/approvals', { cookie: head })).status, 403);
  const dashboard = (await call('/api/dashboard/approvals', { cookie: admin })).body;
  assert.deepEqual(dashboard.due, { count: 1, total: 30 });
  // The questioned current-month expense is waiting on the employee, not on approval.
  assert.deepEqual(dashboard.notYetDue, { count: 1, total: 25 });
  assert.deepEqual(dashboard.awaitingReimbursement, { count: 2, total: 50 });
  assert.deepEqual(
    dashboard.departments.map(row => row.department),
    ['Engineering']
  );

  // 6. Once its month has ended an expense is locked for its owner while it is checked.
  const change = (cookie, item, date, amount) =>
    call(`/api/expenses/${item.id}`, {
      method: 'PUT',
      cookie,
      body: { merchant: 'Changed', amount, currency: 'EUR', category: 'Other', date, note: '' }
    });
  const mine = async () => (await call('/api/expenses', { cookie: staff })).body.expenses;
  assert.equal((await mine()).find(item => item.id === endedTwo.id).ownerCanChange, false);
  const lockedEdit = await change(staff, endedTwo, `${previousMonth}-16`, 99);
  assert.equal(lockedEdit.status, 409);
  assert.match(lockedEdit.body.error, /being checked/);
  assert.equal(
    (await call(`/api/expenses/${endedTwo.id}`, { method: 'DELETE', cookie: staff })).status,
    409
  );
  // A question hands it back; the employee's change returns it for review.
  assert.equal((await review(head, endedTwo.id, 'question', 'Receipt?')).status, 200);
  assert.equal((await mine()).find(item => item.id === endedTwo.id).ownerCanChange, true);
  const answered = await change(staff, endedTwo, `${previousMonth}-16`, 31);
  assert.equal(answered.status, 200);
  assert.equal(answered.body.expense.reviewStatus, 'pending');
  assert.equal(answered.body.expense.ownerCanChange, false);
  // Current-month expenses stay editable; a Super User can still delete a locked one.
  const fresh = await expense(staff, today, 7);
  assert.equal((await change(staff, fresh, today, 8)).status, 200);
  assert.equal(
    (await call(`/api/expenses/${endedTwo.id}`, { method: 'DELETE', cookie: admin })).status,
    200
  );
  // 7. A reimbursement opens with the expenses it paid, for printing and export.
  const staffId = (await call('/api/auth/me', { cookie: staff })).body.user.id;
  const sent = await call(`/api/users/${staffId}/reimbursements`, {
    method: 'POST',
    cookie: admin,
    body: {
      expenseIds: [superCurrent.id, ended.id],
      paymentDate: today,
      reference: 'PAY-001',
      message: 'Paid by bank transfer'
    }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const reimbursementId = sent.body.reimbursement.id;
  const detailPath = `/api/users/${staffId}/reimbursements/${reimbursementId}`;
  assert.equal((await call(detailPath, { cookie: head })).status, 403);
  assert.equal((await call(detailPath, { cookie: staff })).status, 403);
  assert.equal((await call(`${detailPath}0`, { cookie: admin })).status, 404);
  const detail = (await call(detailPath, { cookie: admin })).body;
  assert.equal(detail.reimbursement.reference, 'PAY-001');
  assert.equal(detail.reimbursement.amount, 50);
  assert.equal(detail.user.email, 'staff@example.test');
  // Oldest first, whatever order they were selected in.
  assert.deepEqual(
    detail.expenses.map(item => item.id),
    [ended.id, superCurrent.id]
  );
  assert.equal(detail.missing, 0);
  // An expense deleted later is reported as missing rather than breaking the page.
  assert.equal(
    (await call(`/api/expenses/${superCurrent.id}`, { method: 'DELETE', cookie: admin })).status,
    200
  );
  const afterDelete = (await call(detailPath, { cookie: admin })).body;
  assert.equal(afterDelete.expenses.length, 1);
  assert.equal(afterDelete.missing, 1);
});
