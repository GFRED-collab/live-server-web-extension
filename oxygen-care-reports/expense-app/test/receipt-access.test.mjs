import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { mfaTestEnv, signIn } from './sign-in-helper.mjs';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverFile = join(appDir, 'server.mjs');

function testPdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (PDF Preview Works) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let body = '%PDF-1.4\n',
    offset = Buffer.byteLength(body);
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const entry = `${index + 1} 0 obj\n${object}\nendobj\n`;
    body += entry;
    offset += Buffer.byteLength(entry);
  }
  const xrefOffset = offset;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

async function startServer(t, { settings, onDirectory } = {}) {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'oxygen-expenses-test-'));
  if (onDirectory) onDirectory(workingDirectory);
  if (settings) {
    await mkdir(join(workingDirectory, 'data'), { recursive: true });
    await writeFile(join(workingDirectory, 'data', 'settings.json'), JSON.stringify(settings));
  }
  const port = 32000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverFile], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      SUPERUSER_EMAIL: 'admin@example.test',
      SUPERUSER_PASSWORD: 'AdminPassword123!',
      ...mfaTestEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => {
    errors += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${errors}`)), 5000);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}: ${errors}`));
    });
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
    await rm(workingDirectory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

async function request(base, path, { cookie = '', method = 'GET', body } = {}) {
  const csrf = /(?:^|;\s*)oc_csrf=([^;]+)/.exec(cookie)?.[1];
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'x-csrf-token': csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
}

// Password plus authenticator code; the session cookies arrive with the code step.
async function login(base, email, password) {
  const result = await signIn(base, email, password);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const combined = result.setCookie;
  const session = /oc_session=([^;,]+)/.exec(combined)?.[1];
  const csrf = /oc_csrf=([^;,]+)/.exec(combined)?.[1];
  assert.ok(session && csrf, 'sign-in must set session and CSRF cookies');
  assert.match(combined, /oc_session=[^,]+;[^,]*HttpOnly;[^,]*SameSite=Lax;[^,]*Secure/);
  return result.cookie;
}

async function createUser(base, adminCookie, values) {
  const response = await request(base, '/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      password: 'EmployeePass123!',
      jobDescription: 'Test account',
      carRegistration: '',
      mileageEnabled: false,
      ...values
    }
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text).user;
}

test('company-paid category settings persist and enforce reimbursement boundaries', async t => {
  let directory;
  const base = await startServer(t, {
    settings: { categories: ['Other'], departments: ['Engineering'], mileageRate: 0.5 },
    onDirectory: value => {
      directory = value;
    }
  });
  const admin = await login(base, 'admin@example.test', 'AdminPassword123!');
  const getSettings = async (url = base, cookie = admin) =>
    (await request(url, '/api/settings', { cookie })).json();
  assert.deepEqual((await getSettings()).companyPaidCategories, ['Fuel Card']);
  const owner = await createUser(base, admin, {
    email: 'category-owner@example.test',
    fullName: 'Category Owner',
    department: 'Engineering'
  });
  const user = await login(base, owner.email, 'EmployeePass123!');
  assert.equal(
    (
      await request(base, '/api/settings/categories', {
        method: 'POST',
        cookie: user,
        body: { name: 'Unauthorised', companyPaid: true }
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request(base, '/api/settings/categories', {
        method: 'POST',
        cookie: admin,
        body: { name: 'Invalid', companyPaid: 'false' }
      })
    ).status,
    400
  );
  for (const body of [
    { name: 'Company Travel', companyPaid: true },
    { name: 'Personal Travel', companyPaid: false },
    { name: 'Legacy Default' },
    { name: 'Temporary', companyPaid: true }
  ]) {
    assert.equal(
      (await request(base, '/api/settings/categories', { method: 'POST', cookie: admin, body }))
        .status,
      201
    );
  }
  assert.equal(
    (
      await request(base, '/api/settings/categories?name=Temporary', {
        method: 'DELETE',
        cookie: admin
      })
    ).status,
    200
  );
  assert.deepEqual((await getSettings()).companyPaidCategories, ['Fuel Card', 'Company Travel']);
  const records = [];
  for (const [category, paid] of [
    ['Company Travel', true],
    ['Personal Travel', false],
    ['Legacy Default', false],
    ['Fuel Card', true]
  ]) {
    const response = await request(base, '/api/expenses', {
      method: 'POST',
      cookie: user,
      body: {
        merchant: 'Category test',
        amount: 10,
        currency: 'EUR',
        category,
        date: '2026-10-06',
        note: '',
        receipt: null,
        companyPaid: !paid
      }
    });
    assert.equal(response.status, 201);
    const record = (await response.json()).expense;
    assert.equal(
      record.companyPaid,
      paid,
      'server classification cannot be overridden by an expense payload'
    );
    records.push(record);
  }
  assert.equal(
    (
      await request(base, '/api/expenses/batch-approve', {
        method: 'POST',
        cookie: admin,
        body: { expenseIds: records.map(e => e.id) }
      })
    ).status,
    200
  );
  const candidates = await (
    await request(base, `/api/users/${owner.id}/reimbursement-candidates`, { cookie: admin })
  ).json();
  assert.deepEqual(candidates.expenses.map(e => e.category).sort(), [
    'Legacy Default',
    'Personal Travel'
  ]);
  const dashboard = await (
    await request(base, '/api/dashboard/expenses?year=2026', { cookie: admin })
  ).json();
  assert.equal(dashboard.months[9].totalsByCurrency.EUR, 20);
  assert.equal(dashboard.months[9].companyPaidTotalsByCurrency.EUR, 20);
  for (const record of records.filter(e => e.companyPaid)) {
    const response = await request(base, `/api/users/${owner.id}/reimbursements`, {
      method: 'POST',
      cookie: admin,
      body: {
        expenseIds: [record.id],
        paymentDate: '2026-10-06',
        reference: 'Test',
        message: 'Payment test'
      }
    });
    assert.equal(response.status, 409);
  }
  assert.equal(
    (
      await request(base, '/api/settings/categories?name=Company%20Travel', {
        method: 'DELETE',
        cookie: admin
      })
    ).status,
    409
  );
  const persisted = JSON.parse(await readFile(join(directory, 'data', 'settings.json'), 'utf8'));
  const restarted = await startServer(t, { settings: persisted });
  const restartedAdmin = await login(restarted, 'admin@example.test', 'AdminPassword123!');
  assert.deepEqual((await getSettings(restarted, restartedAdmin)).companyPaidCategories, [
    'Fuel Card',
    'Company Travel'
  ]);
});

test('receipt view and download are distinct and enforce every role boundary', async t => {
  // Expenses can be edited until their month ends, so the edited expense is dated today.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const base = await startServer(t);
  const adminCookie = await login(base, 'admin@example.test', 'AdminPassword123!');
  const mileageRateSaved = await request(base, '/api/settings/categories', {
    method: 'POST',
    cookie: adminCookie,
    body: { mileageRate: 0.5 }
  });
  assert.equal(mileageRateSaved.status, 200);
  const sessionOnly = adminCookie.split(';', 1)[0];
  const blockedWithoutCsrf = await request(base, '/api/users', {
    method: 'POST',
    cookie: sessionOnly,
    body: { email: 'blocked@example.test' }
  });
  assert.equal(blockedWithoutCsrf.status, 403);
  assert.match(blockedWithoutCsrf.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(blockedWithoutCsrf.headers.get('strict-transport-security'), /max-age=31536000/);
  const oversizedProfile = await request(base, '/api/users', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      email: 'oversized@example.test',
      password: 'EmployeePass123!',
      fullName: 'X'.repeat(101),
      role: 'regular',
      department: 'Engineering',
      jobDescription: '',
      carRegistration: '',
      mileageEnabled: false
    }
  });
  assert.equal(oversizedProfile.status, 400);
  const owner = await createUser(base, adminCookie, {
    email: 'owner@example.test',
    fullName: 'Receipt Owner',
    role: 'regular',
    department: 'Engineering',
    mileageEnabled: true
  });
  await createUser(base, adminCookie, {
    email: 'other@example.test',
    fullName: 'Other User',
    role: 'regular',
    department: 'Sales'
  });
  await createUser(base, adminCookie, {
    email: 'head@example.test',
    fullName: 'Department Head',
    role: 'department_head',
    department: 'Engineering'
  });
  await createUser(base, adminCookie, {
    email: 'logout@example.test',
    fullName: 'Logout Test',
    role: 'regular',
    department: 'Engineering'
  });
  const logoutCookie = await login(base, 'logout@example.test', 'EmployeePass123!');
  const loggedOut = await request(base, '/logout', { cookie: logoutCookie });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.get('location'), '/');
  assert.match(loggedOut.headers.get('set-cookie'), /oc_session=;/);
  const endedSession = await request(base, '/api/auth/me', { cookie: logoutCookie });
  assert.equal(endedSession.status, 401);
  const ownerCookie = await login(base, owner.email, 'EmployeePass123!');
  const otherCookie = await login(base, 'other@example.test', 'EmployeePass123!');
  const headCookie = await login(base, 'head@example.test', 'EmployeePass123!');
  const odometerSaved = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      month: '2026-08',
      car1OpeningReading: 100,
      car1ClosingReading: 150,
      car2OpeningReading: 200,
      car2ClosingReading: 275
    }
  });
  assert.equal(odometerSaved.status, 201, await odometerSaved.clone().text());
  const odometer = (await odometerSaved.json()).odometer;
  assert.equal(odometer.car1Kilometres, 50);
  assert.equal(odometer.car2Kilometres, 75);
  assert.equal(odometer.kilometres, 125);
  const carriedOdometer = await request(base, '/api/odometer/month?month=2026-09', {
    cookie: ownerCookie
  });
  const carried = await carriedOdometer.json();
  assert.equal(carried.car1OpeningReading, 150);
  assert.equal(carried.car2OpeningReading, 275);
  assert.equal(carried.car1OpeningIsCarried, true);
  assert.equal(carried.car2OpeningIsCarried, true);
  const invalidOdometer = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      month: '2026-09',
      car1OpeningReading: 150,
      car1ClosingReading: 160,
      car2OpeningReading: 275,
      car2ClosingReading: 274
    }
  });
  assert.equal(invalidOdometer.status, 400);
  const singleCar = {
    month: '2026-09',
    car1OpeningReading: 150,
    car1ClosingReading: 210,
    car2OpeningReading: '',
    car2ClosingReading: ''
  };
  const oneCarSaved = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: singleCar
  });
  assert.equal(oneCarSaved.status, 201);
  assert.equal((await oneCarSaved.json()).odometer.kilometres, 60);
  const oneCarReloaded = await (
    await request(base, '/api/odometer/month?month=2026-09', { cookie: ownerCookie })
  ).json();
  assert.equal(
    oneCarReloaded.car2OpeningReading,
    null,
    'unused Car 2 must not be replaced by an older carried reading'
  );
  assert.equal(oneCarReloaded.car2ClosingReading, null);
  assert.equal(oneCarReloaded.car2Kilometres, null);
  assert.equal(oneCarReloaded.kilometres, 60);
  for (const fields of [
    { car2OpeningReading: 275 },
    { car2ClosingReading: 300 },
    { car2OpeningReading: 'invalid', car2ClosingReading: 300 }
  ]) {
    assert.equal(
      (
        await request(base, '/api/odometer/month', {
          method: 'POST',
          cookie: ownerCookie,
          body: { ...singleCar, ...fields }
        })
      ).status,
      400
    );
  }
  const twoCarsUpdated = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...singleCar, car2OpeningReading: 275, car2ClosingReading: 300 }
  });
  assert.equal(twoCarsUpdated.status, 200);
  assert.equal((await twoCarsUpdated.json()).odometer.kilometres, 85);
  const oneCarUpdated = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: singleCar
  });
  assert.equal(oneCarUpdated.status, 200);
  assert.equal((await oneCarUpdated.json()).odometer.kilometres, 60);
  const omittedSecondCar = await request(base, '/api/odometer/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: { month: '2026-10', car1OpeningReading: 210, car1ClosingReading: 210 }
  });
  assert.equal(omittedSecondCar.status, 201);
  assert.equal((await omittedSecondCar.json()).odometer.kilometres, 0);
  // A claim can be changed until its month ends (then it is locked while it is checked).
  const currentMonth = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date());
  const mileageCreated = await request(base, '/api/mileage/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: { month: currentMonth, kilometres: 100 }
  });
  assert.equal(mileageCreated.status, 201, await mileageCreated.clone().text());
  const mileageId = (await mileageCreated.json()).expense.id;
  const mileageUpdated = await request(base, '/api/mileage/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: { month: currentMonth, kilometres: 125 }
  });
  assert.equal(mileageUpdated.status, 200, await mileageUpdated.clone().text());
  const updatedMileage = (await mileageUpdated.json()).expense;
  assert.equal(updatedMileage.id, mileageId);
  assert.equal(updatedMileage.kilometres, 125);
  assert.equal(updatedMileage.amount, 62.5);
  assert.equal(updatedMileage.category, 'Mileage Expense');
  assert.equal(updatedMileage.reviewStatus, 'pending');
  const approvedMileage = await request(base, `/api/expenses/${mileageId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'approved', note: '' }
  });
  assert.equal(approvedMileage.status, 200, await approvedMileage.clone().text());
  const lockedMileage = await request(base, '/api/mileage/month', {
    method: 'POST',
    cookie: ownerCookie,
    body: { month: currentMonth, kilometres: 150 }
  });
  assert.equal(lockedMileage.status, 403);
  const batchExpense = async (cookie, merchant, amount) => {
    const response = await request(base, '/api/expenses', {
      method: 'POST',
      cookie,
      body: {
        merchant,
        amount,
        currency: 'EUR',
        category: 'Other',
        date: '2026-09-13',
        note: '',
        receipt: null
      }
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text).expense;
  };
  const batchOne = await batchExpense(ownerCookie, 'Batch Approval One', 21);
  const batchTwo = await batchExpense(ownerCookie, 'Batch Approval Two', 22);
  const outsideDepartment = await batchExpense(otherCookie, 'Outside Department', 23);
  assert.equal(
    (
      await request(base, '/api/expenses/batch-approve', {
        method: 'POST',
        cookie: ownerCookie,
        body: { expenseIds: [batchOne.id] }
      })
    ).status,
    403
  );
  const mixedDepartment = await request(base, '/api/expenses/batch-approve', {
    method: 'POST',
    cookie: headCookie,
    body: { expenseIds: [batchOne.id, outsideDepartment.id] }
  });
  assert.equal(mixedDepartment.status, 409);
  const approvedBatch = await request(base, '/api/expenses/batch-approve', {
    method: 'POST',
    cookie: headCookie,
    body: { expenseIds: [batchOne.id, batchTwo.id] }
  });
  assert.equal(approvedBatch.status, 200);
  assert.equal((await approvedBatch.json()).approved, 2);
  assert.equal(
    (
      await request(base, '/api/expenses/batch-approve', {
        method: 'POST',
        cookie: headCookie,
        body: { expenseIds: [batchOne.id] }
      })
    ).status,
    409
  );
  const departmentHeadExpense = await batchExpense(headCookie, 'Department Head Batch Expense', 24);
  const superBatch = await request(base, '/api/expenses/batch-approve', {
    method: 'POST',
    cookie: adminCookie,
    body: { expenseIds: [outsideDepartment.id, departmentHeadExpense.id] }
  });
  assert.equal(superBatch.status, 200, await superBatch.clone().text());
  assert.equal((await superBatch.json()).approved, 2);
  assert.equal(
    (
      await request(base, '/api/expenses/batch-approve', {
        method: 'POST',
        cookie: adminCookie,
        body: { expenseIds: [outsideDepartment.id] }
      })
    ).status,
    409
  );
  const pdf = testPdf();
  const malformedImage = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      merchant: 'Malformed',
      amount: 10,
      currency: 'EUR',
      category: 'Other',
      date: '2026-09-13',
      note: '',
      receipt: {
        mediaType: 'image/png',
        image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
      }
    }
  });
  assert.equal(malformedImage.status, 400);
  const invalidDate = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      merchant: 'Impossible date',
      amount: 10,
      currency: 'EUR',
      category: 'Other',
      date: '2026-02-30',
      note: '',
      receipt: null
    }
  });
  assert.equal(invalidDate.status, 400);
  assert.equal((await invalidDate.json()).code, 'invalid_date');
  const emojiExpense = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      merchant: '😂',
      amount: 12.5,
      currency: 'EUR',
      category: 'Other',
      date: '2026-09-13',
      note: '☮️👇💩',
      receipt: null
    }
  });
  assert.equal(emojiExpense.status, 201, await emojiExpense.clone().text());
  assert.equal((await emojiExpense.json()).expense.merchant, '😂');
  const malformedOcr = await request(base, '/api/ocr', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      mediaType: 'image/png',
      image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    }
  });
  assert.equal(malformedOcr.status, 400);
  const created = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      merchant: 'PDF Test',
      amount: 10,
      currency: 'EUR',
      category: 'Other',
      date: today,
      note: '',
      receipt: { mediaType: 'application/pdf', image: pdf.toString('base64') }
    }
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const expenseId = JSON.parse(createdText).expense.id;
  const duplicateBody = {
    merchant: 'PDF Test',
    amount: 10,
    currency: 'EUR',
    category: 'Other',
    date: today,
    note: '',
    receipt: { mediaType: 'application/pdf', image: pdf.toString('base64') }
  };
  const duplicateWarning = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: duplicateBody
  });
  assert.equal(duplicateWarning.status, 409);
  const duplicateWarningBody = await duplicateWarning.json();
  assert.equal(duplicateWarningBody.code, 'possible_duplicate');
  assert.match(duplicateWarningBody.error, /Are you sure you want to save it\?/);
  const confirmedDuplicate = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...duplicateBody, confirmDuplicate: true }
  });
  assert.equal(confirmedDuplicate.status, 201, await confirmedDuplicate.text());
  const retryBody = {
    ...duplicateBody,
    submissionId: '12345678-1234-1234-1234-123456789abc',
    confirmDuplicate: true
  };
  const retries = await Promise.all(
    Array.from({ length: 4 }, () =>
      request(base, '/api/expenses', { method: 'POST', cookie: ownerCookie, body: retryBody })
    )
  );
  assert.deepEqual(retries.map(r => r.status).sort(), [200, 200, 200, 201]);
  const retryResults = await Promise.all(retries.map(r => r.json()));
  assert.equal(new Set(retryResults.map(r => r.expense.id)).size, 1);
  const replayWithoutConfirmation = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...retryBody, confirmDuplicate: false }
  });
  assert.equal(replayWithoutConfirmation.status, 200);
  const conflict = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...retryBody, amount: 11 }
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'submission_conflict');
  const intentional = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: { ...retryBody, submissionId: '12345678-1234-1234-1234-123456789abd' }
  });
  assert.equal(intentional.status, 201);
  assert.notEqual((await intentional.json()).expense.id, retryResults[0].expense.id);
  const viewPath = `/api/expenses/${expenseId}/receipt/view`;
  const downloadPath = `/api/expenses/${expenseId}/receipt/download`;
  const previewPath = `/api/expenses/${expenseId}/receipt/preview/1`;

  for (const cookie of [ownerCookie, headCookie, adminCookie]) {
    const view = await request(base, viewPath, { cookie });
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-type'), /^text\/html/);
    const viewHtml = await view.text();
    assert.match(viewHtml, new RegExp(`${expenseId}/receipt/preview/1`));
    assert.match(viewHtml, new RegExp(`${expenseId}/receipt/download`));
    assert.match(viewHtml, /location\.replace\(event\.currentTarget\.href\)/);
    assert.match(viewHtml, /href="\/">Back<\/a>/);

    const preview = await request(base, previewPath, { cookie });
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.deepEqual(
      Buffer.from(await preview.arrayBuffer()).subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );

    const download = await request(base, downloadPath, { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  }

  const reportsReturn = await request(
    base,
    `${viewPath}?returnTo=${encodeURIComponent('/reports.html?year=2026&department=Sales')}`,
    { cookie: adminCookie }
  );
  assert.match(
    await reportsReturn.text(),
    /href="\/reports\.html\?year=2026&amp;department=Sales">Back<\/a>/
  );
  const unsafeReturn = await request(
    base,
    `${viewPath}?returnTo=${encodeURIComponent('https://example.com/')}`,
    { cookie: ownerCookie }
  );
  assert.match(await unsafeReturn.text(), /href="\/">Back<\/a>/);

  assert.equal((await request(base, viewPath)).status, 401);
  assert.equal((await request(base, previewPath)).status, 401);
  assert.equal((await request(base, downloadPath)).status, 401);
  assert.equal((await request(base, viewPath, { cookie: otherCookie })).status, 403);
  assert.equal((await request(base, previewPath, { cookie: otherCookie })).status, 403);
  assert.equal((await request(base, downloadPath, { cookie: otherCookie })).status, 403);

  const png = await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: '#f5f5f5' }
  })
    .png()
    .toBuffer();
  const imageCreated = await request(base, '/api/expenses', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      merchant: 'Image Test',
      amount: 11,
      currency: 'EUR',
      category: 'Other',
      date: '2026-09-13',
      note: '',
      receipt: { mediaType: 'image/png', image: png.toString('base64') }
    }
  });
  const imageCreatedText = await imageCreated.text();
  assert.equal(imageCreated.status, 201, imageCreatedText);
  const imageExpenseId = JSON.parse(imageCreatedText).expense.id;
  const imageView = await request(base, `/api/expenses/${imageExpenseId}/receipt/view`, {
    cookie: ownerCookie
  });
  assert.equal(imageView.status, 200);
  const imageHtml = await imageView.text();
  assert.match(imageHtml, /href="\/">Back<\/a>/);
  assert.match(imageHtml, new RegExp(`${imageExpenseId}/receipt/content`));
  const imageContent = await request(base, `/api/expenses/${imageExpenseId}/receipt/content`, {
    cookie: ownerCookie
  });
  assert.equal(imageContent.status, 200);
  assert.equal(imageContent.headers.get('content-type'), 'image/jpeg');
  const storedImage = Buffer.from(await imageContent.arrayBuffer());
  assert.deepEqual(storedImage.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
  const metadata = await sharp(storedImage).metadata();
  assert.ok(Math.max(metadata.width, metadata.height) <= 2000);
  assert.ok(storedImage.length <= 2 * 1024 * 1024);
  assert.notDeepEqual(storedImage, png);
  assert.equal(
    (
      await request(base, `/api/expenses/${imageExpenseId}/receipt/content`, {
        cookie: otherCookie
      })
    ).status,
    403
  );

  const editBody = {
    merchant: 'PDF Test Updated',
    amount: 12.5,
    currency: 'EUR',
    category: 'Travel',
    date: today,
    note: 'Corrected before approval'
  };
  const edited = await request(base, `/api/expenses/${expenseId}`, {
    method: 'PUT',
    cookie: ownerCookie,
    body: editBody
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const editedExpense = await edited.json();
  assert.equal(editedExpense.expense.merchant, editBody.merchant);
  assert.equal(editedExpense.expense.reviewStatus, 'pending');
  assert.equal(editedExpense.expense.hasReceipt, true);
  assert.equal(
    (
      await request(base, `/api/expenses/${expenseId}`, {
        method: 'PUT',
        cookie: otherCookie,
        body: editBody
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request(base, `/api/expenses/${expenseId}`, {
        method: 'PUT',
        cookie: adminCookie,
        body: editBody
      })
    ).status,
    403
  );

  const approved = await request(base, `/api/expenses/${expenseId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { status: 'approved', note: '' }
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const lockedEdit = await request(base, `/api/expenses/${expenseId}`, {
    method: 'PUT',
    cookie: ownerCookie,
    body: { ...editBody, merchant: 'Must Not Save' }
  });
  assert.equal(lockedEdit.status, 403);
  const ownerExpenses = await request(base, '/api/expenses', { cookie: ownerCookie });
  const savedExpense = (await ownerExpenses.json()).expenses.find(
    expense => expense.id === expenseId
  );
  assert.equal(savedExpense.merchant, editBody.merchant);
  assert.equal(savedExpense.reviewStatus, 'approved');

  assert.equal(
    (await request(base, `/api/expenses/${expenseId}/receipt`, { cookie: ownerCookie })).status,
    404
  );
  assert.equal(
    (await request(base, `/api/expenses/${expenseId}/receipt/image`, { cookie: ownerCookie }))
      .status,
    404
  );
});
