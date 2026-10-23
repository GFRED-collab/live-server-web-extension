import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mfaTestEnv, totp } from './sign-in-helper.mjs';

const serverFile = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server.mjs');

async function startServer(t, directory, env = {}) {
  const port = 32000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [serverFile], {
    cwd: directory,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SUPERUSER_EMAIL: 'admin@example.test',
      SUPERUSER_PASSWORD: 'AdminPassword123!',
      ...env
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
  const stop = () =>
    child.exitCode === null
      ? new Promise(resolve => {
          child.once('exit', resolve);
          child.kill('SIGTERM');
        })
      : Promise.resolve();
  t.after(stop);
  return { base: `http://127.0.0.1:${port}`, stop };
}

const cookie = (setCookie, name) => new RegExp(`${name}=([^;,]*)`).exec(setCookie || '')?.[1];

test('two-step sign-in: setup, codes, recovery, limits and resets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-expenses-mfa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(
    join(directory, 'data', 'settings.json'),
    JSON.stringify({ categories: ['Other'], departments: ['Engineering'] })
  );

  // Without the encryption key, sign-in stops at the password with a clear message.
  let server = await startServer(t, directory);
  const noKey = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPassword123!' })
  });
  assert.equal(noKey.status, 503);
  assert.match((await noKey.json()).error, /not configured/);
  await server.stop();

  server = await startServer(t, directory, mfaTestEnv);
  const { base } = server;
  const password = async (email, pass) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    const setCookie = response.headers.get('set-cookie') || '';
    return {
      status: response.status,
      body: await response.json(),
      setCookie,
      challenge: `oc_challenge=${cookie(setCookie, 'oc_challenge')}`
    };
  };
  const verify = async (challenge, code) => {
    const response = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: challenge },
      body: JSON.stringify({ code })
    });
    const setCookie = response.headers.get('set-cookie') || '';
    return {
      status: response.status,
      body: await response.json(),
      session: `oc_session=${cookie(setCookie, 'oc_session')}; oc_csrf=${cookie(setCookie, 'oc_csrf')}`
    };
  };
  const me = session => fetch(`${base}/api/auth/me`, { headers: { cookie: session } });
  const step = () => Math.floor(Date.now() / 30_000);

  // 1. A correct password alone does not sign anyone in.
  const first = await password('admin@example.test', 'AdminPassword123!');
  assert.equal(first.status, 200);
  assert.equal(first.body.step, 'totp_setup');
  assert.equal(cookie(first.setCookie, 'oc_session'), undefined);
  assert.match(first.setCookie, /oc_challenge=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);
  assert.match(first.body.otpauthUrl, /^otpauth:\/\/totp\/Oxygen%20Care%20Expenses/);
  assert.match(first.body.qrSvg, /^<svg/);
  assert.equal((await me(first.challenge)).status, 401);
  assert.equal((await password('admin@example.test', 'wrong-password-1')).status, 401);

  // 2. Setup: a wrong code is refused; the right one signs in and issues recovery codes.
  // (Signing in again replaced the first challenge, so start a fresh one.)
  const setup = await password('admin@example.test', 'AdminPassword123!');
  const key = setup.body.key;
  assert.equal((await verify(setup.challenge, '000000')).status, 401);
  const done = await verify(setup.challenge, totp(key, step()));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.recoveryCodes.length, 10);
  assert.equal((await me(done.session)).status, 200);
  const recovery = done.body.recoveryCodes;
  const used = step();

  // 3. Next sign-in: the same 30-second code can't be replayed; a later one works.
  const second = await password('admin@example.test', 'AdminPassword123!');
  assert.equal(second.body.step, 'totp');
  assert.equal(second.body.key, undefined, 'the key is only shown during setup');
  const replay = await verify(second.challenge, totp(key, used));
  assert.equal(replay.status, 401);
  assert.equal((await verify(second.challenge, totp(key, used + 1))).status, 200);

  // 4. A recovery code works once, typed in any case or spacing.
  const third = await password('admin@example.test', 'AdminPassword123!');
  const viaRecovery = await verify(third.challenge, recovery[0].toLowerCase().replace('-', ' '));
  assert.equal(viaRecovery.status, 200);
  assert.equal(viaRecovery.body.recoveryCodesLeft, 9);
  const fourth = await password('admin@example.test', 'AdminPassword123!');
  assert.equal((await verify(fourth.challenge, recovery[0])).status, 401);

  // 5. Five wrong codes end the sign-in; the challenge can't be used afterwards.
  for (let attempt = 2; attempt <= 4; attempt++)
    assert.equal((await verify(fourth.challenge, '123456')).status, 401);
  const fifth = await verify(fourth.challenge, '123456');
  assert.equal(fifth.status, 401);
  assert.equal(fifth.body.restart, true);
  assert.equal((await verify(fourth.challenge, recovery[1])).body.restart, true);
  // Expired or unknown challenges start again too.
  assert.equal((await verify('oc_challenge=nope', '123456')).body.restart, true);

  // 6. Resets: a Super User resets someone else; not themselves; others can't at all.
  const admin = (
    await verify((await password('admin@example.test', 'AdminPassword123!')).challenge, recovery[2])
  ).session;
  const csrf = cookie(admin, 'oc_csrf');
  const call = (session, path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        cookie: session,
        'content-type': 'application/json',
        'x-csrf-token': cookie(session, 'oc_csrf') || csrf
      }
    });
  const created = await call(admin, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      email: 'staff@example.test',
      password: 'EmployeePass123!',
      fullName: 'Staff Member',
      role: 'regular',
      department: 'Engineering',
      jobDescription: '',
      carRegistration: '',
      mileageEnabled: false
    })
  });
  assert.equal(created.status, 201);
  const staffId = (await created.json()).user.id;
  const staffSetup = await password('staff@example.test', 'EmployeePass123!');
  const staff = (await verify(staffSetup.challenge, totp(staffSetup.body.key, step()))).session;
  const listed = await (await call(admin, '/api/users')).json();
  const staffRecord = listed.users.find(user => user.id === staffId);
  assert.equal(staffRecord.mfaEnabled, true);
  assert.equal(JSON.stringify(listed).includes('mfaSecret'), false, 'keys never leave the server');
  assert.equal(JSON.stringify(listed).includes('mfaRecoveryHashes'), false);
  assert.equal((await call(staff, `/api/users/${staffId}/mfa`, { method: 'DELETE' })).status, 403);
  const adminId = (await (await me(admin)).json()).user.id;
  assert.equal((await call(admin, `/api/users/${adminId}/mfa`, { method: 'DELETE' })).status, 400);
  assert.equal((await call(admin, `/api/users/${staffId}/mfa`, { method: 'DELETE' })).status, 200);
  assert.equal((await me(staff)).status, 401, 'reset signs the person out');
  assert.equal((await password('staff@example.test', 'EmployeePass123!')).body.step, 'totp_setup');

  // 7. The emergency Super User password reset also clears that Super User's authenticator.
  await server.stop();
  server = await startServer(t, directory, {
    ...mfaTestEnv,
    RESET_SUPERUSER_PASSWORD: 'NewAdminPassword123!'
  });
  const response = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'NewAdminPassword123!' })
  });
  assert.equal((await response.json()).step, 'totp_setup');
});

test('with TWO_STEP_SIGN_IN off, the password alone signs in and no key is needed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-expenses-mfa-off-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'data'), { recursive: true });
  await writeFile(
    join(directory, 'data', 'settings.json'),
    JSON.stringify({ categories: ['Other'], departments: ['Engineering'] })
  );
  const { base } = await startServer(t, directory, { TWO_STEP_SIGN_IN: 'off' });
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'AdminPassword123!' })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.step, 'none');
  assert.equal(body.user.email, 'admin@example.test');
  const setCookie = response.headers.get('set-cookie');
  const session = `oc_session=${cookie(setCookie, 'oc_session')}`;
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: session } })).status, 200);
});
