import { createServer } from 'node:http';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import QRCode from 'qrcode';
import sharp from 'sharp';

sharp.concurrency(1);
// SVG receipts are unsupported; disable the decoder as defence in depth.
sharp.block({ operation: ['VipsForeignLoadSvg'] });

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const maxBody = 15 * 1024 * 1024;
const receiptImageUploadMaxBytes = 10 * 1024 * 1024;
const receiptImageStoredMaxBytes = 2 * 1024 * 1024;
const receiptPdfMaxBytes = 4 * 1024 * 1024;
const publicDir = join(process.cwd(), 'public');
const dataDir = join(process.cwd(), 'data');
const usersFile = join(dataDir, 'users.json');
const expensesFile = join(dataDir, 'expenses.json');
const odometerFile = join(dataDir, 'odometer-readings.json');
const settingsFile = join(dataDir, 'settings.json');
const receiptsDir = join(dataDir, 'receipts');
const auditFile = join(dataDir, 'security-audit.log');
const authFailuresFile = join(dataDir, 'auth-failures.json');
const sessions = new Map();
const rateBuckets = new Map();
const ocrUsage = new Map();
let dataWriteQueue = Promise.resolve();
let auditWriteQueue = Promise.resolve();
const sessionHours = 12;
const sessionIdleMinutes = positiveInteger(process.env.SESSION_IDLE_MINUTES, 20, 12 * 60);
// TWO_STEP_SIGN_IN=off turns the authenticator step off for everyone (temporary, until the hosting
// migration). Saved authenticators are kept for when it is turned back on.
const twoStepEnabled = process.env.TWO_STEP_SIGN_IN !== 'off';
function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}
const loginLimit = positiveInteger(process.env.LOGIN_RATE_LIMIT, 10, 100);
const ocrLimit = positiveInteger(process.env.OCR_RATE_LIMIT, 8, 100);
const ocrDailyLimit = positiveInteger(process.env.OCR_DAILY_LIMIT, 20, 1_000);
const ocrMaxConcurrent = positiveInteger(process.env.OCR_MAX_CONCURRENT, 2, 10);
const upstreamTimeoutMs = positiveInteger(process.env.OCR_TIMEOUT_MS, 45_000, 120_000);
const auditLogMaxBytes = positiveInteger(
  process.env.AUDIT_LOG_MAX_BYTES,
  10 * 1024 * 1024,
  100 * 1024 * 1024
);
const auditLogArchives = positiveInteger(process.env.AUDIT_LOG_ARCHIVES, 12, 120);
const accountFailureLimit = positiveInteger(process.env.ACCOUNT_FAILURE_LIMIT, 5, 20);
const accountLockMinutes = positiveInteger(process.env.ACCOUNT_LOCK_MINUTES, 15, 24 * 60);
const receiptStorageMaxBytes = positiveInteger(
  process.env.RECEIPT_STORAGE_MAX_BYTES,
  2 * 1024 * 1024 * 1024,
  20 * 1024 * 1024 * 1024
);
let ocrInFlight = 0;
let pdfPreviewInFlight = 0;
const pdfPreviewMaxConcurrent = 2;
const pdfPreviewMaxPages = 20;
const allowedReceiptTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const ocrImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const companyPaidCategory = 'Fuel Card';
const mileageExpenseCategory = 'Mileage Expense';
const textLimits = Object.freeze({
  fullName: 100,
  email: 254,
  jobDescription: 120,
  carRegistration: 20,
  employeeCode: 20,
  department: 80,
  category: 60,
  merchant: 120,
  note: 300,
  message: 300,
  password: 128
});
const defaultCategories = [
  'Food',
  'Travel',
  'Office',
  'Software',
  'Entertainment',
  'Health',
  'Fuel',
  companyPaidCategory,
  mileageExpenseCategory,
  'Sundries',
  'Other'
];
const currencies = ['EUR'];
const defaultDepartments = ['Engineering', 'Sales', 'Warehouse', 'In-House', 'Marketing'];
let categories = [...defaultCategories];
let companyPaidCategories = [companyPaidCategory];
const isCompanyPaid = expense =>
  expense.expenseType !== 'mileage' && companyPaidCategories.includes(expense.category);
let departments = [...defaultDepartments];
// Mileage is paid per KM at the rate for the car's engine size, set by a Super User.
const engineBands = Object.freeze([
  ['upTo1200', 'Up to 1,200cc'],
  ['from1201To1500', '1,201cc to 1,500cc'],
  ['over1500', '1,501cc and over'],
  ['electric', 'Electric']
]);
const engineBandKeys = engineBands.map(([key]) => key);
const engineBandLabel = key => engineBands.find(([band]) => band === key)?.[1] || '';
let mileageRates = Object.fromEntries(engineBandKeys.map(key => [key, 0]));
// Optional 6-digit code per category (e.g. an accounts code), by category name.
let categoryCodes = {};
// Staff cannot add, change or delete expenses dated before this date (YYYY-MM-DD, '' for none).
let expenseCutoffDate = '';
const settingsPayload = () => ({
  categories,
  departments,
  companyPaidCategories,
  categoryCodes,
  mileageRates,
  engineBands: engineBands.map(([key, label]) => ({ key, label })),
  expenseCutoffDate
});
const validRate = value => Number.isFinite(value) && value >= 0 && value <= 100;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function requestNonce() {
  return randomBytes(18).toString('base64url');
}
function securityHeaders(nonce = '') {
  const nonceSource = nonce ? ` 'nonce-${nonce}'` : '';
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'${nonceSource}; script-src-attr 'unsafe-hashes' 'sha256-Ul1RMxNBbPGH9E+ofhdT7m0RVSwiCXU33cMrTtNPpo8='; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    ...(process.env.NODE_ENV === 'production'
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {})
  };
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers
  });
  res.end(JSON.stringify(body));
}
function logoutAndRedirect(req, res) {
  const token = cookieValue(req, 'oc_session');
  if (token) sessions.delete(token);
  res.writeHead(303, {
    'Location': '/',
    'Cache-Control': 'no-store',
    'Set-Cookie': clearCookies(),
    ...securityHeaders()
  });
  res.end();
}
function requestKey(req, scope) {
  return `${scope}:${req.socket.remoteAddress || 'unknown'}`;
}
function takeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (rateBuckets.size > 10_000)
    for (const [bucketKey, bucket] of rateBuckets)
      if (!bucket.some(hit => hit > now - windowMs)) rateBuckets.delete(bucketKey);
  const hits = (rateBuckets.get(key) || []).filter(hit => hit > now - windowMs);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}
function rateLimit(req, res, scope, limit, windowMs) {
  if (!takeRateLimit(requestKey(req, scope), limit, windowMs)) {
    send(
      res,
      429,
      { error: 'Too many requests. Please wait and try again.' },
      { 'Retry-After': String(Math.ceil(windowMs / 1000)) }
    );
    return false;
  }
  return true;
}
function requestOriginIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
function requireSameOrigin(req, res) {
  if (!requestOriginIsAllowed(req)) {
    send(res, 403, { error: 'Cross-site request blocked.' });
    return false;
  }
  return true;
}
function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) if (session.user.id === userId) sessions.delete(token);
}
function pruneSessions(now = Date.now()) {
  for (const [token, session] of sessions)
    if (session.expires < now || session.idleExpires < now) sessions.delete(token);
}
function refreshUserSessions(user) {
  for (const session of sessions.values())
    if (session.user.id === user.id) session.user = publicUser(user);
}
function auditArchiveName() {
  return `security-audit-${new Date().toISOString().replace(/[-:.]/g, '')}.log`;
}
async function rotateAuditLog(nextEntryBytes) {
  try {
    const current = await stat(auditFile);
    if (current.size + nextEntryBytes <= auditLogMaxBytes) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await rename(auditFile, join(dataDir, auditArchiveName()));
  const archives = (await readdir(dataDir))
    .filter(name => /^security-audit-\d{8}T\d{6}\d{3}Z\.log$/.test(name))
    .sort();
  const expired = archives.slice(0, Math.max(0, archives.length - auditLogArchives));
  await Promise.all(expired.map(name => unlink(join(dataDir, name))));
}
function audit(event, details = {}) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
  auditWriteQueue = auditWriteQueue
    .then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await rotateAuditLog(Buffer.byteLength(line));
      await appendFile(auditFile, line, { mode: 0o600 });
    })
    .catch(error => {
      console.error('Could not write security audit log', error.message);
    });
  return auditWriteQueue;
}
function cleanEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function validEmail(value) {
  return value.length <= textLimits.email && /^\S+@\S+\.\S+$/.test(value);
}
function validatePassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= textLimits.password;
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
function cookieValue(req, name) {
  return (req.headers.cookie || '')
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function requestSession(req) {
  const token = cookieValue(req, 'oc_session');
  const session = token && sessions.get(token);
  const now = Date.now();
  if (!session || session.expires < now || session.idleExpires < now) {
    if (token) sessions.delete(token);
    return null;
  }
  session.idleExpires = now + sessionIdleMinutes * 60_000;
  return session;
}
function sessionUser(req) {
  return requestSession(req)?.user || null;
}
function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `oc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionHours * 3600}${secure}`;
}
function csrfCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `oc_csrf=${token}; Path=/; SameSite=Strict; Max-Age=${sessionHours * 3600}${secure}`;
}
function clearCookies() {
  return [
    'oc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'oc_csrf=; Path=/; SameSite=Strict; Max-Age=0'
  ];
}
function requireCsrf(req, res) {
  const session = requestSession(req),
    supplied = req.headers['x-csrf-token'];
  if (!session || typeof supplied !== 'string') {
    send(res, 403, {
      error: 'Security token is missing or expired. Refresh the app and try again.'
    });
    return false;
  }
  const actual = Buffer.from(supplied),
    expected = Buffer.from(session.csrfToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    send(res, 403, { error: 'Security token is invalid. Refresh the app and try again.' });
    return false;
  }
  return true;
}
// Employee codes: letters, numbers and hyphens (stored in capitals), unique across accounts.
function cleanEmployeeCode(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return code.length <= textLimits.employeeCode && /^[A-Z0-9-]*$/.test(code) ? code : null;
}
const employeeCodeTaken = (all, code, exceptId) =>
  Boolean(code) && all.some(user => user.id !== exceptId && user.employeeCode === code);
const validEngineBand = value => value === '' || engineBandKeys.includes(value);
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName || '',
    role: user.role,
    department: user.department || '',
    jobDescription: user.jobDescription || '',
    carRegistration: user.carRegistration || '',
    employeeCode: user.employeeCode || '',
    engineBand: user.engineBand || '',
    mileageEnabled: user.mileageEnabled === true,
    mfaEnabled: Boolean(user.mfaSecret),
    createdAt: user.createdAt
  };
}
function requireUser(req, res, role) {
  const user = sessionUser(req);
  if (!user) {
    send(res, 401, { error: 'Please sign in.' });
    return null;
  }
  if (role && user.role !== role) {
    send(res, 403, { error: 'Super User access is required.' });
    return null;
  }
  return user;
}
async function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBody) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  try {
    return JSON.parse((await bodyOf(req)).toString('utf8'));
  } catch {
    throw new Error('Invalid request.');
  }
}
async function users() {
  try {
    return JSON.parse(await readFile(usersFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function saveUsers(value) {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${usersFile}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, usersFile);
}
async function expenses() {
  try {
    return JSON.parse(await readFile(expensesFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function saveExpenses(value) {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${expensesFile}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, expensesFile);
}
async function odometerReadings() {
  try {
    const value = JSON.parse(await readFile(odometerFile, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function saveOdometerReadings(value) {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${odometerFile}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, odometerFile);
}
function cleanSettingList(value, fallback, maximum) {
  const list = Array.isArray(value) ? value : fallback;
  return [
    ...new Set(
      list
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item && item.length <= maximum)
    )
  ];
}
async function loadSettings() {
  try {
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    categories = cleanSettingList(saved.categories, defaultCategories, textLimits.category);
    for (const required of [companyPaidCategory, mileageExpenseCategory])
      if (!categories.includes(required)) categories.push(required);
    companyPaidCategories = [
      ...new Set([
        companyPaidCategory,
        ...cleanSettingList(saved.companyPaidCategories, [], textLimits.category).filter(
          name => categories.includes(name) && name !== mileageExpenseCategory
        )
      ])
    ];
    departments = cleanSettingList(saved.departments, defaultDepartments, textLimits.department);
    // Older settings had one rate for every car: it becomes the starting rate for each band.
    const legacyRate = Number(saved.mileageRate);
    for (const key of engineBandKeys) {
      const value = Number(saved.mileageRates?.[key] ?? legacyRate);
      mileageRates[key] = validRate(value) ? value : 0;
    }
    categoryCodes = Object.fromEntries(
      Object.entries(saved.categoryCodes || {}).filter(
        ([name, code]) => categories.includes(name) && /^\d{6}$/.test(code)
      )
    );
    expenseCutoffDate =
      typeof saved.expenseCutoffDate === 'string' && validDate(saved.expenseCutoffDate)
        ? saved.expenseCutoffDate
        : '';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveSettings();
  }
}
async function saveSettings() {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${settingsFile}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      {
        categories,
        departments,
        mileageRates,
        companyPaidCategories,
        categoryCodes,
        expenseCutoffDate
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await rename(temporary, settingsFile);
}
async function authFailures() {
  try {
    const value = JSON.parse(await readFile(authFailuresFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
async function saveAuthFailures(value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${authFailuresFile}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, authFailuresFile);
}
function authFailureKey(email, req) {
  return createHash('sha256')
    .update(`${cleanEmail(email)}\n${req.socket.remoteAddress || 'unknown'}`)
    .digest('hex');
}
async function loginLockState(email, req) {
  const all = await authFailures(),
    now = Date.now(),
    key = authFailureKey(email, req);
  for (const [entryKey, entry] of Object.entries(all))
    if (!entry || Number(entry.updatedAt || 0) < now - 24 * 60 * 60_000) delete all[entryKey];
  const entry = all[key];
  if (entry?.lockedUntil > now)
    return { all, key, locked: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  return { all, key, locked: false };
}
async function recordLoginFailure(state) {
  const now = Date.now(),
    previous = state.all[state.key],
    count = Number(previous?.count || 0) + 1;
  state.all[state.key] = {
    count,
    updatedAt: now,
    lockedUntil: count >= accountFailureLimit ? now + accountLockMinutes * 60_000 : 0
  };
  await saveAuthFailures(state.all);
  return state.all[state.key];
}
async function clearLoginFailures(state) {
  if (!state.all[state.key]) return;
  delete state.all[state.key];
  await saveAuthFailures(state.all);
}
async function appSettings(req, res) {
  if (!requireUser(req, res)) return;
  send(res, 200, settingsPayload());
}
async function addSetting(req, res, kind) {
  if (!requireUser(req, res, 'super')) return;
  try {
    const input = await jsonBody(req);
    if (kind === 'category' && Object.hasOwn(input, 'mileageRates')) {
      const rates = input.mileageRates;
      if (!rates || typeof rates !== 'object' || Array.isArray(rates))
        return send(res, 400, { error: 'Mileage rates are invalid.' });
      const next = {};
      for (const key of engineBandKeys) {
        const value = Number(rates[key]);
        if (!validRate(value))
          return send(res, 400, {
            error: `Enter a rate between 0 and 100 for ${engineBandLabel(key)}.`
          });
        next[key] = Math.round(value * 10000) / 10000;
      }
      mileageRates = next;
      await saveSettings();
      return send(res, 200, settingsPayload());
    }
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (kind === 'category' && code && !/^\d{6}$/.test(code))
      return send(res, 400, { error: 'A category code must be exactly 6 digits.' });
    if (kind === 'category' && code && Object.values(categoryCodes).includes(code))
      return send(res, 409, { error: 'Another category already uses that code.' });
    if (
      kind === 'category' &&
      Object.hasOwn(input, 'companyPaid') &&
      typeof input.companyPaid !== 'boolean'
    )
      return send(res, 400, { error: 'Company paid must be true or false.' });
    const value = typeof input.name === 'string' ? input.name.trim() : '';
    const list = kind === 'category' ? categories : departments,
      maximum = textLimits[kind];
    if (!value || value.length > maximum)
      return send(res, 400, { error: `Enter a ${kind} name of 1–${maximum} characters.` });
    if (list.some(item => item.toLowerCase() === value.toLowerCase()))
      return send(res, 409, { error: 'That item already exists.' });
    list.push(value);
    if (kind === 'category' && input.companyPaid === true) companyPaidCategories.push(value);
    if (kind === 'category' && code) categoryCodes[value] = code;
    await saveSettings();
    send(res, 201, settingsPayload());
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function removeSetting(req, res, kind) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  const value = new URL(req.url, 'http://local').searchParams.get('name')?.trim() || '';
  const list = kind === 'category' ? categories : departments;
  const index = list.findIndex(item => item.toLowerCase() === value.toLowerCase());
  if (index < 0) return send(res, 404, { error: `That ${kind} does not exist.` });
  if (kind === 'category' && [companyPaidCategory, mileageExpenseCategory].includes(list[index]))
    return send(res, 409, {
      error: `${list[index]} is a required category and cannot be deleted.`
    });
  if (kind === 'department' && (await users()).some(user => user.department === list[index]))
    return send(res, 409, {
      error: 'This department is assigned to one or more users and cannot be deleted.'
    });
  if (kind === 'category' && (await expenses()).some(expense => expense.category === list[index]))
    return send(res, 409, {
      error: 'This category is used by existing expenses and cannot be deleted.'
    });
  const removed = list.splice(index, 1)[0];
  if (kind === 'category') {
    companyPaidCategories = companyPaidCategories.filter(name => name !== removed);
    delete categoryCodes[removed];
  }
  await saveSettings();
  await audit(`${kind}_deleted`, { actorId: actor.id, name: removed });
  send(res, 200, settingsPayload());
}
// Renames a category (existing expenses follow the new name) and/or sets its 6-digit code.
async function updateCategory(req, res) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const input = await jsonBody(req);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const current = categories.find(item => item.toLowerCase() === name.toLowerCase());
    if (!current) return send(res, 404, { error: 'That category does not exist.' });
    const newName = typeof input.newName === 'string' ? input.newName.trim() : current;
    const code =
      typeof input.code === 'string' ? input.code.trim() : (categoryCodes[current] ?? '');
    if (!newName || newName.length > textLimits.category)
      return send(res, 400, {
        error: `Enter a category name of 1–${textLimits.category} characters.`
      });
    if (newName !== current && [companyPaidCategory, mileageExpenseCategory].includes(current))
      return send(res, 409, { error: `${current} is a required category and cannot be renamed.` });
    if (
      newName.toLowerCase() !== current.toLowerCase() &&
      categories.some(item => item.toLowerCase() === newName.toLowerCase())
    )
      return send(res, 409, { error: 'Another category already has that name.' });
    if (code && !/^\d{6}$/.test(code))
      return send(res, 400, { error: 'A category code must be exactly 6 digits.' });
    if (
      code &&
      Object.entries(categoryCodes).some(([other, value]) => other !== current && value === code)
    )
      return send(res, 409, { error: 'Another category already uses that code.' });
    if (newName !== current) {
      const all = await expenses();
      let renamed = 0;
      for (const expense of all)
        if (expense.category === current && expense.expenseType !== 'mileage') {
          expense.category = newName;
          renamed++;
        }
      if (renamed) await saveExpenses(all);
      categories[categories.indexOf(current)] = newName;
      companyPaidCategories = companyPaidCategories.map(item =>
        item === current ? newName : item
      );
      delete categoryCodes[current];
    }
    if (code) categoryCodes[newName] = code;
    else delete categoryCodes[newName];
    await saveSettings();
    await audit('category_updated', { actorId: actor.id, name: current, newName, code });
    send(res, 200, settingsPayload());
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
// The Super User closes older periods: expenses dated before this date are locked for staff.
async function setExpenseCutoff(req, res) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const { date = '' } = await jsonBody(req);
    if (date !== '' && dateValidationError(date))
      return send(res, 400, { error: 'Choose a valid cut-off date that is not in the future.' });
    expenseCutoffDate = date;
    await saveSettings();
    await audit('expense_cutoff_changed', { actorId: actor.id, date });
    send(res, 200, settingsPayload());
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function bootstrapSuperUser() {
  const all = await users();
  const email = cleanEmail(process.env.SUPERUSER_EMAIL);
  const password = process.env.SUPERUSER_PASSWORD;
  const existing = all.find(user => user.role === 'super');
  if (existing) {
    const reset = process.env.RESET_SUPERUSER_PASSWORD;
    if (reset) {
      if (email !== existing.email || !validatePassword(reset))
        console.warn(
          'Super User reset skipped. Set the existing SUPERUSER_EMAIL and a 12+ character RESET_SUPERUSER_PASSWORD.'
        );
      else {
        existing.passwordHash = hashPassword(reset);
        // An emergency reset also clears the authenticator, in case the phone was lost too.
        clearMfa(existing);
        await saveUsers(all);
        console.log(`Reset Super User password and authenticator: ${existing.email}`);
      }
    }
    return;
  }
  if (!email || !validatePassword(password)) {
    console.warn(
      'No Super User exists. Set SUPERUSER_EMAIL and a 12+ character SUPERUSER_PASSWORD, then restart.'
    );
    return;
  }
  all.push({
    id: randomBytes(16).toString('hex'),
    email,
    passwordHash: hashPassword(password),
    role: 'super',
    createdAt: new Date().toISOString()
  });
  await saveUsers(all);
  console.log(`Created initial Super User: ${email}`);
}
function todayLocal(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function dateValidationError(value, today = todayLocal()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a valid date.';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    Number(value.slice(0, 4)) < 2000
  )
    return 'Enter a valid date from the year 2000 onwards.';
  if (value > today) return `The date cannot be in the future. Today in Ireland is ${today}.`;
  return '';
}
function validDate(value) {
  return !dateValidationError(value);
}
const lastDayOfMonth = month => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};
// Staff cannot add, change or delete an expense dated before the Super User's cut-off date. A
// mileage claim counts from the last day of its month.
function expenseClosed(expense) {
  if (!expenseCutoffDate) return false;
  const date =
    expense.expenseType === 'mileage' && /^\d{4}-\d{2}$/.test(expense.mileageMonth || '')
      ? lastDayOfMonth(expense.mileageMonth)
      : expense.date;
  return typeof date === 'string' && date < expenseCutoffDate;
}
const closedMessage = () =>
  `Expenses dated before ${expenseCutoffDate} are closed. Contact a Super User if this needs to change.`;
// Department Heads may approve an expense only once its month has ended: from the 1st of the
// following month (Irish time). Super Users are not limited.
function approvalOpensOn(expense) {
  const month = /^(\d{4})-(\d{2})/.exec(expense.mileageMonth || expense.date || '');
  if (!month) return '';
  const year = Number(month[1]) + (month[2] === '12' ? 1 : 0),
    next = month[2] === '12' ? 1 : Number(month[2]) + 1;
  return `${year}-${String(next).padStart(2, '0')}-01`;
}
function approvalOpen(expense, today = todayLocal()) {
  return today >= approvalOpensOn(expense);
}
// Once an expense's month has ended it is with the reviewer, so its owner cannot change or
// delete it (the reviewer checks a fixed record). A question or decline hands it back.
const ownerLockedMessage =
  'This expense is being checked now that its month has ended. You can change it if your manager questions or declines it.';
function ownerCanChange(expense, today = todayLocal()) {
  const status = expense.reviewStatus || 'pending';
  if (status === 'approved') return false;
  return status !== 'pending' || !approvalOpen(expense, today);
}
function publicExpense(expense) {
  const { userId, receiptFile, receiptHash, ...value } = expense;
  if (value.expenseType === 'mileage') value.category = mileageExpenseCategory;
  return {
    ...value,
    companyPaid: isCompanyPaid(value),
    categoryCode: categoryCodes[value.category] || '',
    closed: expenseClosed(value),
    hasReceipt: Boolean(receiptFile),
    approvalOpensOn: approvalOpensOn(value),
    approvalOpen: approvalOpen(value),
    ownerCanChange: ownerCanChange(value)
  };
}
function validatedReceipt(value) {
  if (value == null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    !allowedReceiptTypes.has(value.mediaType) ||
    typeof value.image !== 'string' ||
    !/^[A-Za-z0-9+/=]+$/.test(value.image)
  )
    throw new Error('Receipt attachment is invalid.');
  const bytes = Buffer.from(value.image, 'base64');
  const maximumBytes =
    value.mediaType === 'application/pdf' ? receiptPdfMaxBytes : receiptImageUploadMaxBytes;
  if (!bytes.length || bytes.length > maximumBytes)
    throw new Error(
      value.mediaType === 'application/pdf'
        ? 'PDF receipts must be 4 MB or smaller.'
        : 'Receipt images must be 10 MB or smaller before compression.'
    );
  const signatures = {
    'image/jpeg': [0xff, 0xd8, 0xff],
    'image/png': [0x89, 0x50, 0x4e, 0x47],
    'image/webp': [0x52, 0x49, 0x46, 0x46],
    'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d]
  };
  if (!signatures[value.mediaType].every((byte, index) => bytes[index] === byte))
    throw new Error('Receipt file does not match its image type.');
  if (
    value.mediaType === 'image/webp' &&
    (bytes.length < 12 || bytes.toString('ascii', 8, 12) !== 'WEBP')
  )
    throw new Error('Receipt file does not match its image type.');
  return {
    bytes,
    extension:
      value.mediaType === 'image/jpeg'
        ? 'jpg'
        : value.mediaType === 'image/png'
          ? 'png'
          : value.mediaType === 'application/pdf'
            ? 'pdf'
            : 'webp',
    hash: createHash('sha256').update(bytes).digest('hex')
  };
}
async function prepareReceipt(receipt) {
  if (!receipt) return null;
  if (receipt.extension === 'pdf') {
    await validateReceiptContent(receipt);
    return receipt;
  }
  try {
    const pipeline = sharp(receipt.bytes, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });
    let bytes = await pipeline.clone().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    if (bytes.length > receiptImageStoredMaxBytes)
      bytes = await pipeline.clone().jpeg({ quality: 72, mozjpeg: true }).toBuffer();
    if (!bytes.length || bytes.length > receiptImageStoredMaxBytes)
      throw new Error('The compressed receipt remains too large. Crop the image and try again.');
    const prepared = {
      bytes,
      extension: 'jpg',
      hash: createHash('sha256').update(bytes).digest('hex')
    };
    await validateReceiptContent(prepared);
    return prepared;
  } catch (error) {
    if (/compressed receipt remains too large/i.test(error.message)) throw error;
    throw new Error('Receipt image is malformed or unsupported.');
  }
}
function imageDimensions(bytes, extension) {
  if (extension === 'png') {
    if (
      bytes.length < 24 ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      return null;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (extension === 'webp') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30)
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (
      kind === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    )
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
    }
    return null;
  }
  if (extension === 'jpg') {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker
        )
      )
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}
async function validateReceiptContent(receipt) {
  if (!receipt) return;
  if (receipt.extension !== 'pdf') {
    const dimensions = imageDimensions(receipt.bytes, receipt.extension);
    if (!dimensions) throw new Error('Receipt image is malformed or unsupported.');
    const [width, height] = dimensions;
    if (width < 1 || height < 1 || width > 12_000 || height > 12_000 || width * height > 40_000_000)
      throw new Error('Receipt image dimensions are too large.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-receipt-check-'));
  const source = join(directory, 'receipt.pdf');
  try {
    await writeFile(source, receipt.bytes, { mode: 0o600 });
    const info = (await runPdfTool('pdfinfo', [source])).toString('utf8');
    const pages = Number(/^Pages:\s+(\d+)\s*$/im.exec(info)?.[1]);
    const encrypted = /^Encrypted:\s+yes\s*$/im.test(info);
    if (!Number.isInteger(pages) || pages < 1 || pages > pdfPreviewMaxPages)
      throw new Error(`PDF receipts must contain 1–${pdfPreviewMaxPages} pages.`);
    if (encrypted) throw new Error('Password-protected PDF receipts are not supported.');
  } catch (error) {
    if (/PDF receipts|Password-protected/.test(error.message)) throw error;
    throw new Error('Receipt PDF is malformed or unsupported.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function receiptStorageBytes() {
  try {
    const names = await readdir(receiptsDir),
      sizes = await Promise.all(
        names
          .filter(name => /^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(name))
          .map(async name => (await stat(join(receiptsDir, name))).size)
      );
    return sizes.reduce((total, size) => total + size, 0);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
function normalisedMerchant(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function dateDistanceInDays(left, right) {
  const a = Date.parse(`${left}T00:00:00Z`),
    b = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / 86_400_000 : Infinity;
}
function duplicateReceiptExpense(records, userId, input, receipt) {
  if (!receipt) return null;
  const merchant = normalisedMerchant(input.merchant);
  const amount = Number(input.amount);
  return (
    records.find(record => {
      if (record.userId !== userId) return false;
      if (record.receiptHash && record.receiptHash === receipt.hash) return true;
      const existingMerchant = normalisedMerchant(record.merchant);
      const sameMerchant =
        merchant.length >= 3 &&
        existingMerchant.length >= 3 &&
        (merchant === existingMerchant ||
          merchant.includes(existingMerchant) ||
          existingMerchant.includes(merchant));
      return (
        sameMerchant &&
        Math.abs(Number(record.amount) - amount) < 0.01 &&
        dateDistanceInDays(record.date, input.date) <= 3
      );
    }) || null
  );
}
async function saveReceipt(expenseId, receipt) {
  if (!receipt) return '';
  if ((await receiptStorageBytes()) + receipt.bytes.length > receiptStorageMaxBytes)
    throw new Error('Receipt storage is full. Contact the site administrator.');
  await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  const filename = `${expenseId}.${receipt.extension}`;
  const temporary = join(receiptsDir, `.${filename}.tmp`);
  await writeFile(temporary, receipt.bytes, { mode: 0o600 });
  await rename(temporary, join(receiptsDir, filename));
  return filename;
}
async function removeReceipt(filename) {
  if (!filename || !/^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(filename)) return;
  try {
    await unlink(join(receiptsDir, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not remove receipt', error.message);
  }
}
async function canViewExpense(viewer, expense) {
  if (viewer.role === 'super' || viewer.id === expense.userId) return true;
  if (viewer.role !== 'department_head') return false;
  const owner = (await users()).find(user => user.id === expense.userId);
  return Boolean(owner && owner.role === 'regular' && owner.department === viewer.department);
}

// Two-step sign-in: after the password, a code from an authenticator app (TOTP, RFC 6238:
// SHA-1, 30-second steps, 6 digits). Everyone sets it up at their first sign-in and receives
// ten one-time recovery codes. Keys are stored encrypted with MFA_ENCRYPTION_KEY.
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}
function totpCode(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
const totpStep = (now = Date.now()) => Math.floor(now / 30_000);
function sameText(left, right) {
  const a = Buffer.from(String(left)),
    b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
// The current step or one either side (clock drift); a step already used is refused.
function verifyTotp(secret, code, lastStep = null, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = totpStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (lastStep !== null && candidate <= lastStep) continue;
    if (sameText(totpCode(secret, candidate), code)) return candidate;
  }
  return null;
}
function mfaKey() {
  const key = Buffer.from(process.env.MFA_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32)
    throw Object.assign(new Error('Two-step sign-in is not configured on this server.'), {
      status: 503
    });
  return key;
}
function encryptMfaSecret(secret) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', mfaKey(), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function decryptMfaSecret(stored) {
  const raw = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', mfaKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}
const recoveryAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normaliseRecoveryCode = value =>
  String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
const recoveryHash = code =>
  createHash('sha256')
    .update(`recovery:${normaliseRecoveryCode(code)}`)
    .digest('hex');
function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = Array.from(
      { length: 8 },
      () => recoveryAlphabet[randomInt(recoveryAlphabet.length)]
    ).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
function clearMfa(user) {
  delete user.mfaSecret;
  delete user.mfaEnabledAt;
  delete user.mfaLastStep;
  delete user.mfaRecoveryHashes;
}
// Passwords accepted but codes still outstanding, held for 10 minutes in memory only.
const signInChallenges = new Map();
const challengeMinutes = 10,
  maximumCodeAttempts = 5,
  codeFailureLimit = 10;
const codeFailures = new Map();
function pruneChallenges(now = Date.now()) {
  for (const [token, challenge] of signInChallenges)
    if (challenge.expires < now) signInChallenges.delete(token);
  for (const [userId, times] of codeFailures) {
    const recent = times.filter(time => time > now - 15 * 60_000);
    if (recent.length) codeFailures.set(userId, recent);
    else codeFailures.delete(userId);
  }
}
function challengeCookie(token, maxAge = challengeMinutes * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `oc_challenge=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function startSession(res, user, extra = {}) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(token, {
    user: publicUser(user),
    csrfToken,
    expires: now + sessionHours * 3600_000,
    idleExpires: now + sessionIdleMinutes * 60_000
  });
  send(
    res,
    200,
    { user: publicUser(user), idleTimeoutMinutes: sessionIdleMinutes, ...extra },
    { 'Set-Cookie': [sessionCookie(token), csrfCookie(csrfToken), challengeCookie('', 0)] }
  );
}
async function login(req, res) {
  if (!requireSameOrigin(req, res) || !rateLimit(req, res, 'login', loginLimit, 15 * 60_000))
    return;
  try {
    pruneSessions();
    const { email, password } = await jsonBody(req);
    const lock = await loginLockState(email, req);
    if (lock.locked) {
      await audit('login_blocked', { ip: req.socket.remoteAddress || 'unknown' });
      return send(
        res,
        429,
        { error: 'Too many failed sign-in attempts. Please wait and try again.' },
        { 'Retry-After': String(lock.retryAfter) }
      );
    }
    const normalised = cleanEmail(email);
    const user = validEmail(normalised)
      ? (await users()).find(entry => entry.email === normalised)
      : null;
    if (!user || !passwordMatches(password || '', user.passwordHash)) {
      const failure = await recordLoginFailure(lock);
      await audit('login_failed', {
        ip: req.socket.remoteAddress || 'unknown',
        locked: failure.lockedUntil > Date.now()
      });
      return send(res, 401, { error: 'Email or password is incorrect.' });
    }
    await clearLoginFailures(lock);
    if (!twoStepEnabled) {
      await audit('login_succeeded', {
        userId: user.id,
        role: user.role,
        ip: req.socket.remoteAddress || 'unknown',
        secondStep: 'off'
      });
      return startSession(res, user, { step: 'none' });
    }
    // The password is right; the session starts only after the code (/api/auth/verify).
    mfaKey();
    pruneChallenges();
    for (const [token, challenge] of signInChallenges)
      if (challenge.userId === user.id) signInChallenges.delete(token);
    if (signInChallenges.size > 10_000) signInChallenges.clear();
    const token = randomBytes(32).toString('base64url');
    const setup = !user.mfaSecret;
    const secret = setup ? randomBytes(20) : null;
    signInChallenges.set(token, {
      userId: user.id,
      kind: setup ? 'totp_setup' : 'totp',
      pendingSecret: secret,
      attempts: 0,
      expires: Date.now() + challengeMinutes * 60_000
    });
    await audit('login_password_accepted', {
      userId: user.id,
      ip: req.socket.remoteAddress || 'unknown'
    });
    const headers = { 'Set-Cookie': challengeCookie(token) };
    if (!setup) return send(res, 200, { step: 'totp' }, headers);
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(`Oxygen Care Expenses:${user.email}`)}?${new URLSearchParams({ secret: base32Encode(secret), issuer: 'Oxygen Care Expenses', algorithm: 'SHA1', digits: '6', period: '30' })}`;
    send(
      res,
      200,
      {
        step: 'totp_setup',
        key: base32Encode(secret).replace(/(.{4})(?=.)/g, '$1 '),
        otpauthUrl,
        qrSvg: await QRCode.toString(otpauthUrl, {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M'
        })
      },
      headers
    );
  } catch (error) {
    send(res, error.status || 400, { error: error.message });
  }
}
async function verifySignIn(req, res) {
  if (!requireSameOrigin(req, res) || !rateLimit(req, res, 'verify', 30, 15 * 60_000)) return;
  const restart = (status, error) =>
    send(res, status, { error, restart: true }, { 'Set-Cookie': challengeCookie('', 0) });
  try {
    pruneChallenges();
    const { code: rawCode } = await jsonBody(req);
    const code = String(rawCode || '').trim();
    if (!code || code.length > 20) return send(res, 400, { error: 'Enter the code.' });
    const token = cookieValue(req, 'oc_challenge');
    const challenge = token && signInChallenges.get(token);
    if (!challenge) return restart(401, 'Your sign-in has expired. Enter your password again.');
    const all = await users();
    const user = all.find(entry => entry.id === challenge.userId);
    if (!user) {
      signInChallenges.delete(token);
      return restart(401, 'Your sign-in has expired. Enter your password again.');
    }
    if ((codeFailures.get(user.id) || []).length >= codeFailureLimit) {
      signInChallenges.delete(token);
      return restart(429, 'Too many wrong codes. Wait 15 minutes and sign in again.');
    }
    let step = null,
      usedRecovery = false;
    if (challenge.kind === 'totp_setup') step = verifyTotp(challenge.pendingSecret, code);
    else {
      step = verifyTotp(decryptMfaSecret(user.mfaSecret), code, user.mfaLastStep ?? null);
      // A recovery code works once instead of the authenticator code.
      if (step === null && normaliseRecoveryCode(code).length === 8) {
        const hash = recoveryHash(code),
          remaining = user.mfaRecoveryHashes || [];
        if (remaining.includes(hash)) {
          usedRecovery = true;
          user.mfaRecoveryHashes = remaining.filter(value => value !== hash);
        }
      }
    }
    if (step === null && !usedRecovery) {
      codeFailures.set(user.id, [...(codeFailures.get(user.id) || []), Date.now()]);
      challenge.attempts += 1;
      await audit('login_code_failed', {
        userId: user.id,
        ip: req.socket.remoteAddress || 'unknown'
      });
      if (challenge.attempts >= maximumCodeAttempts) {
        signInChallenges.delete(token);
        return restart(401, 'Too many wrong codes. Enter your password again.');
      }
      return send(res, 401, {
        error: 'That code is not right. Use the current code from your authenticator app.'
      });
    }
    signInChallenges.delete(token);
    codeFailures.delete(user.id);
    let recoveryCodes;
    if (challenge.kind === 'totp_setup') {
      recoveryCodes = newRecoveryCodes();
      Object.assign(user, {
        mfaSecret: encryptMfaSecret(challenge.pendingSecret),
        mfaEnabledAt: new Date().toISOString(),
        mfaLastStep: step,
        mfaRecoveryHashes: recoveryCodes.map(recoveryHash)
      });
      await audit('mfa_enrolled', { userId: user.id });
    } else if (step !== null) user.mfaLastStep = step;
    await saveUsers(all);
    await audit('login_succeeded', {
      userId: user.id,
      role: user.role,
      ip: req.socket.remoteAddress || 'unknown',
      ...(usedRecovery ? { recoveryCode: true } : {})
    });
    startSession(res, user, {
      ...(recoveryCodes ? { recoveryCodes } : {}),
      ...(usedRecovery ? { recoveryCodesLeft: user.mfaRecoveryHashes.length } : {})
    });
  } catch (error) {
    send(res, error.status || 400, { error: error.message });
  }
}
// A Super User resets someone's authenticator (for example a lost phone). They are signed out
// and set up a new one at their next sign-in.
async function resetAuthenticator(req, res, id) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  if (id === actor.id)
    return send(res, 400, {
      error: 'You cannot reset your own authenticator. Ask another Super User.'
    });
  const all = await users();
  const target = all.find(user => user.id === id);
  if (!target) return send(res, 404, { error: 'User not found.' });
  clearMfa(target);
  await saveUsers(all);
  invalidateUserSessions(id);
  for (const [token, challenge] of signInChallenges)
    if (challenge.userId === id) signInChallenges.delete(token);
  await audit('mfa_reset', { actorId: actor.id, targetUserId: id });
  send(res, 200, { ok: true });
}
async function createUser(req, res) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const {
      email,
      password,
      fullName = '',
      role = 'regular',
      department = '',
      jobDescription = '',
      carRegistration = '',
      employeeCode: rawEmployeeCode = '',
      engineBand = '',
      mileageEnabled = false
    } = await jsonBody(req);
    const employeeCode = cleanEmployeeCode(rawEmployeeCode);
    if (employeeCode === null)
      return send(res, 400, {
        error: 'Employee codes use up to 20 letters, numbers or hyphens.'
      });
    if (!validEngineBand(engineBand))
      return send(res, 400, { error: 'Choose a valid engine size.' });
    const normalised = cleanEmail(email);
    const cleanField = (value, limit) =>
      typeof value === 'string' && value.trim().length <= limit ? value.trim() : null;
    const fields = {
      fullName: cleanField(fullName, textLimits.fullName),
      department: cleanField(department, textLimits.department),
      jobDescription: cleanField(jobDescription, textLimits.jobDescription),
      carRegistration: cleanField(carRegistration, textLimits.carRegistration)
    };
    if (!validEmail(normalised))
      return send(res, 400, { error: 'Enter a valid email address of up to 254 characters.' });
    if (!fields.fullName)
      return send(res, 400, { error: "Enter the user's full name using up to 100 characters." });
    if (!validatePassword(password))
      return send(res, 400, { error: 'Password must contain 12–128 characters.' });
    if (!['regular', 'department_head', 'super'].includes(role))
      return send(res, 400, { error: 'Choose a valid account type.' });
    if (Object.values(fields).includes(null) || !departments.includes(fields.department))
      return send(res, 400, { error: 'Profile details or department are invalid.' });
    const all = await users();
    if (all.some(user => user.email === normalised))
      return send(res, 409, { error: 'That email already has an account.' });
    if (employeeCodeTaken(all, employeeCode))
      return send(res, 409, { error: 'Another account already uses that employee code.' });
    const user = {
      id: randomBytes(16).toString('hex'),
      email: normalised,
      passwordHash: hashPassword(password),
      role,
      ...fields,
      employeeCode,
      engineBand: role === 'super' ? '' : engineBand,
      mileageEnabled: role !== 'super' && mileageEnabled === true,
      createdAt: new Date().toISOString()
    };
    all.push(user);
    await saveUsers(all);
    await audit('user_created', { actorId: actor.id, targetUserId: user.id, role });
    send(res, 201, { user: publicUser(user) });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function listUsers(req, res) {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  if (!['super', 'department_head'].includes(viewer.role))
    return send(res, 403, { error: 'Review access is required.' });
  const all = await users();
  const people = all.filter(
    user =>
      user.role === 'regular' && (viewer.role === 'super' || user.department === viewer.department)
  );
  send(res, 200, { users: people.map(publicUser) });
}
async function listSuperUsers(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const people = (await users())
    .filter(user => user.role === 'super')
    .sort((left, right) =>
      (left.fullName || left.email).localeCompare(right.fullName || right.email)
    );
  send(res, 200, { users: people.map(publicUser) });
}
async function listDepartmentHeads(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const people = (await users())
    .filter(user => user.role === 'department_head')
    .sort((left, right) =>
      (left.fullName || left.email).localeCompare(right.fullName || right.email)
    );
  send(res, 200, { users: people.map(publicUser) });
}
async function manageSuperUser(req, res, id) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const { action } = await jsonBody(req);
    const all = await users();
    const target = all.find(user => user.id === id);
    if (!target || target.role !== 'super')
      return send(res, 404, { error: 'Super User not found.' });
    if (target.id === actor.id)
      return send(res, 403, { error: 'You cannot change or delete your own Super User account.' });
    if (all.filter(user => user.role === 'super').length < 2)
      return send(res, 409, { error: 'At least one Super User account must remain.' });
    if (action === 'demote') {
      target.role = 'regular';
      target.mileageEnabled = false;
      target.updatedAt = new Date().toISOString();
      await saveUsers(all);
      invalidateUserSessions(target.id);
      await audit('super_user_demoted', { actorId: actor.id, targetUserId: target.id });
      return send(res, 200, { user: publicUser(target) });
    }
    if (action === 'delete') {
      const records = await expenses();
      const removed = records.filter(expense => expense.userId === target.id);
      await saveUsers(all.filter(user => user.id !== target.id));
      await saveExpenses(records.filter(expense => expense.userId !== target.id));
      await Promise.all(removed.map(expense => removeReceipt(expense.receiptFile)));
      invalidateUserSessions(target.id);
      await audit('super_user_deleted', {
        actorId: actor.id,
        targetUserId: target.id,
        expensesDeleted: removed.length
      });
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'Choose a valid Super User action.' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function manageDepartmentHead(req, res, id) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const { action } = await jsonBody(req);
    const all = await users();
    const target = all.find(user => user.id === id);
    if (!target || target.role !== 'department_head')
      return send(res, 404, { error: 'Department Head not found.' });
    if (action === 'demote') {
      target.role = 'regular';
      target.updatedAt = new Date().toISOString();
      await saveUsers(all);
      invalidateUserSessions(target.id);
      await audit('department_head_demoted', {
        actorId: actor.id,
        targetUserId: target.id,
        department: target.department
      });
      return send(res, 200, { user: publicUser(target) });
    }
    if (action === 'delete') {
      const records = await expenses();
      const removed = records.filter(expense => expense.userId === target.id);
      await saveUsers(all.filter(user => user.id !== target.id));
      await saveExpenses(records.filter(expense => expense.userId !== target.id));
      await Promise.all(removed.map(expense => removeReceipt(expense.receiptFile)));
      invalidateUserSessions(target.id);
      await audit('department_head_deleted', {
        actorId: actor.id,
        targetUserId: target.id,
        department: target.department,
        expensesDeleted: removed.length
      });
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'Choose a valid Department Head action.' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function dashboardExpenses(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const all = await expenses();
  const people = await users();
  const reportPeople = people.filter(user => ['regular', 'department_head'].includes(user.role));
  const departmentsByUser = new Map(
    reportPeople.map(user => [user.id, user.department || 'Unassigned'])
  );
  const query = new URL(req.url, 'http://local').searchParams;
  const years = [
    ...new Set(all.map(expense => /^\d{4}/.exec(expense.date || '')?.[0]).filter(Boolean))
  ]
    .sort()
    .reverse();
  const selectedYear = query.get('year') || years[0] || String(new Date().getFullYear());
  const selectedCategory = query.get('category') || 'All';
  const selectedDepartment = query.get('department') || 'All';
  const categories = [...new Set(all.map(expense => expense.category).filter(Boolean))].sort();
  const departments = [...new Set([...departmentsByUser.values()])].sort();
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    count: 0,
    totalsByCurrency: {},
    companyPaidTotalsByCurrency: {}
  }));
  for (const expense of all) {
    const department = departmentsByUser.get(expense.userId) || 'Unassigned';
    if (
      !departmentsByUser.has(expense.userId) ||
      !expense.date?.startsWith(`${selectedYear}-`) ||
      (selectedCategory !== 'All' && expense.category !== selectedCategory) ||
      (selectedDepartment !== 'All' && department !== selectedDepartment)
    )
      continue;
    const month = Number(expense.date.slice(5, 7));
    if (month < 1 || month > 12) continue;
    const bucket = months[month - 1];
    bucket.count += 1;
    const totals = isCompanyPaid(expense)
      ? bucket.companyPaidTotalsByCurrency
      : bucket.totalsByCurrency;
    totals[expense.currency || 'EUR'] =
      (totals[expense.currency || 'EUR'] || 0) + Number(expense.amount || 0);
  }
  send(res, 200, {
    year: selectedYear,
    years: years.length ? years : [selectedYear],
    categories: ['All', ...categories],
    departments: ['All', ...departments],
    months
  });
}
// Super User dashboard: what is due for approval, what is not due yet (current month), and
// approved expenses still awaiting reimbursement, overall and per department.
// Super Users see every department; Department Heads see the regular users of their own
// department (the expenses they approve), broken down per person.
async function dashboardApprovals(req, res) {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  if (!['super', 'department_head'].includes(viewer.role))
    return send(res, 403, { error: 'Review access is required.' });
  const head = viewer.role === 'department_head';
  const people = (await users()).filter(user =>
    head
      ? user.role === 'regular' && user.department === viewer.department
      : ['regular', 'department_head'].includes(user.role)
  );
  const byId = new Map(people.map(user => [user.id, user]));
  const today = todayLocal();
  const empty = () => ({ count: 0, total: 0 });
  const blank = () => ({ due: empty(), notYetDue: empty(), awaitingReimbursement: empty() });
  const overall = blank(),
    departments = new Map();
  for (const expense of await expenses()) {
    const owner = byId.get(expense.userId);
    if (!owner) continue;
    const status = expense.reviewStatus || 'pending';
    const bucket =
      status === 'pending'
        ? approvalOpen(expense, today)
          ? 'due'
          : 'notYetDue'
        : status === 'approved' &&
            owner.role === 'regular' &&
            !expense.reimbursementId &&
            !isCompanyPaid(expense)
          ? 'awaitingReimbursement'
          : null;
    if (!bucket) continue;
    const name = head ? owner.id : owner.department || 'Unassigned';
    if (!departments.has(name)) departments.set(name, blank());
    for (const target of [overall, departments.get(name)]) {
      target[bucket].count += 1;
      target[bucket].total =
        Math.round((target[bucket].total + Number(expense.amount || 0)) * 100) / 100;
    }
  }
  if (head)
    return send(res, 200, {
      today,
      department: viewer.department,
      ...overall,
      people: [...departments]
        .map(([id, values]) => ({ user: publicUser(byId.get(id)), ...values }))
        .sort((left, right) =>
          (left.user.fullName || left.user.email).localeCompare(
            right.user.fullName || right.user.email
          )
        )
    });
  send(res, 200, {
    today,
    ...overall,
    departments: [...departments]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([department, values]) => ({ department, ...values }))
  });
}
async function reportExpenses(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const people = (await users()).filter(user => ['regular', 'department_head'].includes(user.role));
  const byId = new Map(people.map(user => [user.id, user]));
  const rows = (await expenses())
    .filter(expense => byId.has(expense.userId))
    .map(expense => ({ ...publicExpense(expense), user: publicUser(byId.get(expense.userId)) }));
  send(res, 200, {
    expenses: rows,
    users: people.map(publicUser),
    departments: [...new Set(people.map(user => user.department).filter(Boolean))].sort()
  });
}
async function reportOdometer(req, res) {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  if (!['super', 'department_head'].includes(viewer.role))
    return send(res, 403, { error: 'Odometer report access is required.' });
  // Department Heads see their own readings and their department's regular users.
  const people = (await users()).filter(user =>
    viewer.role === 'super'
      ? ['regular', 'department_head'].includes(user.role)
      : user.id === viewer.id || (user.role === 'regular' && user.department === viewer.department)
  );
  const byId = new Map(people.map(user => [user.id, user]));
  const readings = (await odometerReadings())
    .filter(reading => byId.has(reading.userId))
    .map(reading => ({
      ...normaliseOdometerReading(reading),
      user: publicUser(byId.get(reading.userId))
    }));
  send(res, 200, {
    readings,
    users: people.map(publicUser),
    departments: [...new Set(people.map(user => user.department).filter(Boolean))].sort()
  });
}
async function reportReimbursements(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const people = (await users()).filter(user => user.role === 'regular');
  const reimbursements = people.flatMap(user =>
    (Array.isArray(user.notifications) ? user.notifications : [])
      .filter(item => item?.type === 'reimbursement')
      .map(item => ({ ...item, user: publicUser(user) }))
  );
  send(res, 200, {
    reimbursements,
    users: people.map(publicUser),
    departments: [...new Set(people.map(user => user.department).filter(Boolean))].sort()
  });
}
async function activityLog(req, res) {
  if (!requireUser(req, res, 'super')) return;
  const limit = Math.max(
    1,
    Math.min(500, Number(new URL(req.url, 'http://local').searchParams.get('limit') || 200))
  );
  try {
    const entries = (await readFile(auditFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
    send(res, 200, { entries });
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 200, { entries: [] });
    throw error;
  }
}
async function listExpenses(req, res) {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  const targetId = new URL(req.url, 'http://local').searchParams.get('userId') || viewer.id;
  if (targetId !== viewer.id && viewer.role !== 'super') {
    const targetUser = (await users()).find(user => user.id === targetId);
    if (
      viewer.role !== 'department_head' ||
      !targetUser ||
      targetUser.role !== 'regular' ||
      targetUser.department !== viewer.department
    )
      return send(res, 403, { error: 'You can only view expenses in your department.' });
  }
  send(res, 200, {
    expenses: (await expenses())
      .filter(expense => expense.userId === targetId)
      .map(expense => ({
        ...publicExpense(expense),
        reviewStatus: expense.reviewStatus || 'pending',
        reviewNote: expense.reviewNote || ''
      }))
  });
}
function monthToday() {
  return todayLocal().slice(0, 7);
}
function validOdometer(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2_000_000
    ? Math.round(number * 10) / 10
    : null;
}
function normaliseOdometerReading(record) {
  const car1OpeningReading = record.car1OpeningReading ?? record.openingReading ?? null,
    car1ClosingReading = record.car1ClosingReading ?? record.closingReading ?? null;
  const car2OpeningReading = record.car2OpeningReading ?? null,
    car2ClosingReading = record.car2ClosingReading ?? null;
  const distance = (opening, closing) =>
    opening != null &&
    closing != null &&
    Number.isFinite(Number(opening)) &&
    Number.isFinite(Number(closing)) &&
    Number(closing) >= Number(opening)
      ? Math.round((Number(closing) - Number(opening)) * 10) / 10
      : null;
  const car1Kilometres = record.car1Kilometres ?? distance(car1OpeningReading, car1ClosingReading),
    car2Kilometres = record.car2Kilometres ?? distance(car2OpeningReading, car2ClosingReading);
  return {
    ...record,
    car1OpeningReading,
    car1ClosingReading,
    car1Kilometres,
    car2OpeningReading,
    car2ClosingReading,
    car2Kilometres,
    kilometres: Math.round((Number(car1Kilometres || 0) + Number(car2Kilometres || 0)) * 10) / 10
  };
}
function previousOdometerClosing(records, userId, month, car) {
  return (
    records
      .map(normaliseOdometerReading)
      .filter(
        record =>
          record.userId === userId &&
          /^\d{4}-\d{2}$/.test(record.month || '') &&
          record.month < month &&
          Number.isFinite(Number(record[`${car}ClosingReading`]))
      )
      .sort((left, right) => right.month.localeCompare(left.month))[0]?.[`${car}ClosingReading`] ??
    null
  );
}
async function monthlyOdometer(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const month = new URL(req.url, 'http://local').searchParams.get('month') || monthToday();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return send(res, 400, { error: 'Choose a valid month.' });
  const records = await odometerReadings();
  const existing = records.find(record => record.userId === user.id && record.month === month),
    current = existing ? normaliseOdometerReading(existing) : null;
  const car1Carried = previousOdometerClosing(records, user.id, month, 'car1'),
    car2Carried = previousOdometerClosing(records, user.id, month, 'car2');
  send(res, 200, {
    month,
    car1OpeningReading: current?.car1OpeningReading ?? car1Carried,
    car1ClosingReading: current?.car1ClosingReading ?? null,
    car1Kilometres: current?.car1Kilometres ?? null,
    car2OpeningReading: current ? current.car2OpeningReading : car2Carried,
    car2ClosingReading: current?.car2ClosingReading ?? null,
    car2Kilometres: current?.car2Kilometres ?? null,
    kilometres: current?.kilometres ?? null,
    saved: Boolean(current),
    car1OpeningIsCarried: !current && car1Carried !== null,
    car2OpeningIsCarried: !current && car2Carried !== null
  });
}
async function saveMonthlyOdometer(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const {
      month,
      car1OpeningReading,
      car1ClosingReading,
      car2OpeningReading,
      car2ClosingReading
    } = await jsonBody(req);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''))
      return send(res, 400, { error: 'Choose a valid month.' });
    const records = await odometerReadings(),
      car1Opening = validOdometer(car1OpeningReading),
      car1Closing = validOdometer(car1ClosingReading),
      car2Opening = validOdometer(car2OpeningReading),
      car2Closing = validOdometer(car2ClosingReading);
    const car2Unused = [car2OpeningReading, car2ClosingReading].every(
      value => value === '' || value == null
    );
    if (
      car1Opening === null ||
      car1Closing === null ||
      car1Closing < car1Opening ||
      (!car2Unused && (car2Opening === null || car2Closing === null || car2Closing < car2Opening))
    )
      return send(res, 400, {
        error:
          'Enter opening and closing readings for Car 1. For Car 2, enter both readings or leave both blank. Closing readings cannot be lower than opening readings.'
      });
    const car1Kilometres = Math.round((car1Closing - car1Opening) * 10) / 10,
      car2Kilometres = car2Unused ? null : Math.round((car2Closing - car2Opening) * 10) / 10,
      kilometres = Math.round((car1Kilometres + car2Kilometres) * 10) / 10;
    const existing = records.find(record => record.userId === user.id && record.month === month);
    const record = {
      ...(existing || { createdAt: new Date().toISOString() }),
      userId: user.id,
      month,
      car1OpeningReading: car1Opening,
      car1ClosingReading: car1Closing,
      car1Kilometres,
      car2OpeningReading: car2Opening,
      car2ClosingReading: car2Closing,
      car2Kilometres,
      kilometres,
      updatedAt: new Date().toISOString()
    };
    delete record.openingReading;
    delete record.closingReading;
    if (existing) Object.assign(existing, record);
    else records.push(record);
    if (existing) {
      delete existing.openingReading;
      delete existing.closingReading;
    }
    await saveOdometerReadings(records);
    await audit(existing ? 'odometer_log_updated' : 'odometer_log_created', {
      userId: user.id,
      month,
      car1Kilometres,
      car2Kilometres,
      kilometres
    });
    send(res, existing ? 200 : 201, { odometer: record });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
function isMileageUser(user) {
  return Boolean(
    user && ['regular', 'department_head'].includes(user.role) && user.mileageEnabled === true
  );
}
// The per-KM rate for a user's car, from its engine band (null until a Super User sets the band).
const mileageRateFor = user =>
  engineBandKeys.includes(user?.engineBand) ? mileageRates[user.engineBand] : null;
function mileageExpense(records, userId, month) {
  return records.find(
    record =>
      record.userId === userId && record.expenseType === 'mileage' && record.mileageMonth === month
  );
}
async function monthlyMileage(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const account = (await users()).find(entry => entry.id === user.id);
  if (!isMileageUser(account))
    return send(res, 403, { error: 'Mileage expenses have not been allocated to your account.' });
  const month = new URL(req.url, 'http://local').searchParams.get('month') || monthToday();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return send(res, 400, { error: 'Choose a valid month.' });
  const record = mileageExpense(await expenses(), user.id, month);
  send(res, 200, {
    month,
    kilometres: record?.kilometres ?? null,
    amount: record?.amount ?? null,
    submitted: Boolean(record),
    reviewStatus: record?.reviewStatus || 'pending',
    ownerCanChange: record ? ownerCanChange(record) : true,
    closed: expenseClosed({ expenseType: 'mileage', mileageMonth: month }),
    mileageRate: mileageRateFor(account) ?? 0,
    engineBand: account.engineBand || '',
    engineBandLabel: engineBandLabel(account.engineBand)
  });
}
async function saveMonthlyMileage(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const account = (await users()).find(entry => entry.id === user.id);
  if (!isMileageUser(account))
    return send(res, 403, { error: 'Mileage expenses have not been allocated to your account.' });
  try {
    const { month, kilometres: inputKilometres } = await jsonBody(req);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || ''))
      return send(res, 400, { error: 'Choose a valid month.' });
    const kilometres = Number(inputKilometres);
    if (!Number.isFinite(kilometres) || kilometres <= 0 || kilometres > 10000)
      return send(res, 400, { error: 'Enter a monthly distance between 0.1 and 10,000 KM.' });
    if (expenseClosed({ expenseType: 'mileage', mileageMonth: month }))
      return send(res, 409, { code: 'period_closed', error: closedMessage() });
    const mileageRate = mileageRateFor(account);
    if (mileageRate === null)
      return send(res, 400, {
        error: "A Super User must set your car's engine size before mileage can be claimed."
      });
    if (mileageRate <= 0)
      return send(res, 400, {
        error: `A Super User must set the mileage rate for ${engineBandLabel(account.engineBand)} cars before a mileage expense can be saved.`
      });
    const all = await expenses(),
      existing = mileageExpense(all, user.id, month);
    if (existing?.reviewStatus === 'approved')
      return send(res, 403, {
        error: 'An approved mileage expense can only be deleted by a Super User.'
      });
    if (existing && !ownerCanChange(existing)) return send(res, 409, { error: ownerLockedMessage });
    const roundedKilometres = Math.round(kilometres * 10) / 10,
      amount = Math.round(roundedKilometres * mileageRate * 100) / 100;
    const fields = {
      merchant: `Monthly mileage expense · ${month}`,
      amount,
      currency: 'EUR',
      category: mileageExpenseCategory,
      date: `${month}-01`,
      note: `${roundedKilometres} KM at €${mileageRate.toFixed(4)} per KM (${engineBandLabel(account.engineBand)}).`,
      kilometres: roundedKilometres,
      mileageRate,
      engineBand: account.engineBand,
      mileageMonth: month,
      expenseType: 'mileage',
      reviewStatus: 'pending',
      reviewNote: ''
    };
    let record;
    if (existing) {
      Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
      record = existing;
    } else {
      record = {
        id: randomBytes(16).toString('hex'),
        userId: user.id,
        ...fields,
        createdAt: new Date().toISOString()
      };
      all.unshift(record);
    }
    await saveExpenses(all);
    await audit(existing ? 'mileage_expense_updated' : 'mileage_expense_created', {
      userId: user.id,
      expenseId: record.id,
      month,
      kilometres: roundedKilometres,
      amount
    });
    send(res, existing ? 200 : 201, { expense: publicExpense(record) });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
// Serialize creation so simultaneous retries cannot both insert the same submission.
let expenseCreationQueue = Promise.resolve();
async function createExpense(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  if (!['regular', 'department_head'].includes(user.role))
    return send(res, 403, { error: 'Super Users have view-only expense access.' });
  try {
    const input = await jsonBody(req),
      amount = Number(input.amount);
    const submissionId = input.submissionId || '';
    if (submissionId && (typeof submissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(submissionId)))
      return send(res, 400, { error: 'Invalid submission identifier.' });
    let receipt = validatedReceipt(input.receipt);
    const dateError = dateValidationError(input.date);
    if (dateError) return send(res, 400, { code: 'invalid_date', error: dateError });
    if (expenseClosed({ date: input.date }))
      return send(res, 409, { code: 'period_closed', error: closedMessage() });
    if (
      typeof input.merchant !== 'string' ||
      !input.merchant.trim() ||
      input.merchant.length > 120 ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 1_000_000 ||
      !currencies.includes(input.currency) ||
      !categories.includes(input.category) ||
      typeof input.note !== 'string' ||
      input.note.length > 300
    )
      return send(res, 400, { error: 'Expense details are invalid.' });
    const submissionHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.merchant.trim(),
          amount,
          input.currency,
          input.category,
          input.date,
          input.note.trim(),
          receipt ? createHash('sha256').update(receipt.bytes).digest('hex') : ''
        ])
      )
      .digest('hex');
    receipt = await prepareReceipt(receipt);
    const create = async () => {
      const all = await expenses();
      const previous =
        submissionId &&
        all.find(record => record.userId === user.id && record.submissionId === submissionId);
      if (previous) {
        if (previous.submissionHash !== submissionHash)
          return send(res, 409, {
            code: 'submission_conflict',
            error:
              'This submission was already saved with different details. Open the saved expense to edit it.'
          });
        return send(res, 200, { expense: publicExpense(previous) });
      }
      const duplicate = duplicateReceiptExpense(all, user.id, input, receipt);
      if (duplicate && input.confirmDuplicate !== true) {
        await audit('duplicate_expense_prompted', {
          userId: user.id,
          existingExpenseId: duplicate.id,
          exactReceipt: Boolean(receipt?.hash && duplicate.receiptHash === receipt.hash)
        });
        return send(res, 409, {
          code: 'possible_duplicate',
          error: `This may duplicate your ${duplicate.date} ${duplicate.merchant} expense. Are you sure you want to save it?`
        });
      }
      const record = {
        id: randomBytes(16).toString('hex'),
        userId: user.id,
        merchant: input.merchant.trim(),
        amount,
        currency: input.currency,
        category: input.category,
        date: input.date,
        note: input.note.trim(),
        receiptHash: receipt?.hash || '',
        reviewStatus: 'pending',
        reviewNote: '',
        createdAt: new Date().toISOString(),
        ...(submissionId ? { submissionId, submissionHash } : {})
      };
      record.receiptFile = await saveReceipt(record.id, receipt);
      all.unshift(record);
      await saveExpenses(all);
      await audit('expense_created', {
        userId: user.id,
        expenseId: record.id,
        amount: record.amount,
        category: record.category
      });
      send(res, 201, { expense: publicExpense(record) });
    };
    const pending = expenseCreationQueue.then(create);
    expenseCreationQueue = pending.catch(() => {});
    try {
      await pending;
    } catch {
      send(res, 500, { error: 'The save could not be confirmed. Retry this submission safely.' });
    }
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function editExpense(req, res, id) {
  const user = requireUser(req, res);
  if (!user) return;
  if (!['regular', 'department_head'].includes(user.role))
    return send(res, 403, { error: 'Super Users cannot edit expenses.' });
  try {
    const input = await jsonBody(req),
      amount = Number(input.amount),
      all = await expenses();
    const target = all.find(expense => expense.id === id);
    if (!target) return send(res, 404, { error: 'Expense not found.' });
    if (target.userId !== user.id)
      return send(res, 403, { error: 'You can only edit your own expenses.' });
    if (target.reviewStatus === 'approved')
      return send(res, 403, { error: 'Approved expenses cannot be edited.' });
    if (!ownerCanChange(target)) return send(res, 409, { error: ownerLockedMessage });
    if (target.expenseType === 'mileage')
      return send(res, 403, {
        error: 'Mileage expenses must be changed from the monthly mileage form.'
      });
    const dateError = dateValidationError(input.date);
    if (dateError) return send(res, 400, { code: 'invalid_date', error: dateError });
    if (expenseClosed(target) || expenseClosed({ date: input.date }))
      return send(res, 409, { code: 'period_closed', error: closedMessage() });
    if (
      typeof input.merchant !== 'string' ||
      !input.merchant.trim() ||
      input.merchant.length > 120 ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 1_000_000 ||
      !currencies.includes(input.currency) ||
      !categories.includes(input.category) ||
      typeof input.note !== 'string' ||
      input.note.length > 300
    )
      return send(res, 400, { error: 'Expense details are invalid.' });
    Object.assign(target, {
      merchant: input.merchant.trim(),
      amount,
      currency: input.currency,
      category: input.category,
      date: input.date,
      note: input.note.trim(),
      reviewStatus: 'pending',
      reviewNote: ''
    });
    delete target.reviewedAt;
    delete target.reviewedBy;
    await saveExpenses(all);
    send(res, 200, { expense: publicExpense(target) });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function deleteExpense(req, res, id) {
  const viewer = requireUser(req, res);
  if (!viewer) return;
  const all = await expenses();
  const target = all.find(expense => expense.id === id);
  if (!target) return send(res, 404, { error: 'Expense not found.' });
  if (viewer.role !== 'super') {
    if (!['regular', 'department_head'].includes(viewer.role) || target.userId !== viewer.id)
      return send(res, 403, { error: 'You can only delete your own expenses.' });
    if (target.reviewStatus === 'approved')
      return send(res, 403, { error: 'Approved expenses can only be deleted by a Super User.' });
    if (!ownerCanChange(target)) return send(res, 409, { error: ownerLockedMessage });
    if (expenseClosed(target))
      return send(res, 409, { code: 'period_closed', error: closedMessage() });
  }
  await saveExpenses(all.filter(expense => expense.id !== id));
  await removeReceipt(target.receiptFile);
  await audit('expense_deleted', {
    actorId: viewer.id,
    expenseId: id,
    ownerId: target.userId,
    approved: target.reviewStatus === 'approved'
  });
  send(res, 200, { ok: true });
}
async function reviewExpense(req, res, id) {
  const reviewer = requireUser(req, res);
  if (!reviewer) return;
  if (!['super', 'department_head'].includes(reviewer.role))
    return send(res, 403, { error: 'Review access is required.' });
  try {
    const { status, note = '' } = await jsonBody(req);
    if (
      !['approved', 'declined', 'question'].includes(status) ||
      typeof note !== 'string' ||
      note.length > 300 ||
      (['declined', 'question'].includes(status) && !note.trim())
    )
      return send(res, 400, { error: 'A note is required for declined or questioned expenses.' });
    const all = await expenses();
    const target = all.find(expense => expense.id === id);
    if (!target) return send(res, 404, { error: 'Expense not found.' });
    const owner = (await users()).find(user => user.id === target.userId);
    if (
      reviewer.role === 'department_head' &&
      (!owner || owner.role !== 'regular' || owner.department !== reviewer.department)
    )
      return send(res, 403, { error: 'You can only review expenses in your department.' });
    if (target.reviewStatus === 'approved')
      return send(res, 409, { error: 'This expense is already approved and locked.' });
    if (status === 'approved' && reviewer.role === 'department_head' && !approvalOpen(target))
      return send(res, 409, {
        error: `This expense can be approved once its month has ended, from ${approvalOpensOn(target)}.`
      });
    target.reviewStatus = status;
    target.reviewNote = status === 'approved' ? '' : note.trim();
    target.reviewedAt = new Date().toISOString();
    target.reviewedBy = reviewer.email;
    await saveExpenses(all);
    await audit('expense_reviewed', {
      actorId: reviewer.id,
      expenseId: id,
      ownerId: target.userId,
      status
    });
    send(res, 200, {
      expense: {
        id: target.id,
        reviewStatus: target.reviewStatus,
        reviewNote: target.reviewNote,
        reviewedAt: target.reviewedAt,
        reviewedBy: target.reviewedBy
      }
    });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function batchApproveExpenses(req, res) {
  const reviewer = requireUser(req, res);
  if (!reviewer) return;
  if (!['super', 'department_head'].includes(reviewer.role))
    return send(res, 403, { error: 'Expense review access is required.' });
  try {
    const input = await jsonBody(req),
      ids = Array.isArray(input.expenseIds) ? [...new Set(input.expenseIds)] : [];
    if (
      !ids.length ||
      ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id))
    )
      return send(res, 400, { error: 'Select between 1 and 100 pending expenses.' });
    const [all, people] = await Promise.all([expenses(), users()]);
    const usersById = new Map(people.map(user => [user.id, user]));
    const selected = ids.map(id => all.find(expense => expense.id === id));
    const invalid = selected.some(expense => {
      const owner = expense && usersById.get(expense.userId),
        eligibleOwner =
          reviewer.role === 'super'
            ? owner && ['regular', 'department_head'].includes(owner.role)
            : owner?.role === 'regular' && owner.department === reviewer.department;
      return !expense || !eligibleOwner || (expense.reviewStatus || 'pending') !== 'pending';
    });
    if (invalid)
      return send(res, 409, {
        error:
          'One or more selected expenses are no longer pending or available to you. Nothing was approved.'
      });
    if (reviewer.role === 'department_head' && selected.some(expense => !approvalOpen(expense)))
      return send(res, 409, {
        error:
          'Expenses can be approved once their month has ended. Remove current-month expenses and try again. Nothing was approved.'
      });
    const reviewedAt = new Date().toISOString();
    for (const expense of selected)
      Object.assign(expense, {
        reviewStatus: 'approved',
        reviewNote: '',
        reviewedAt,
        reviewedBy: reviewer.email
      });
    await saveExpenses(all);
    await audit('expenses_batch_approved', {
      actorId: reviewer.id,
      count: selected.length,
      expenseIds: ids
    });
    send(res, 200, { approved: selected.length });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function listNotifications(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const account = (await users()).find(entry => entry.id === user.id);
  const notifications = Array.isArray(account?.notifications)
    ? account.notifications
        .filter(item => item && !item.dismissedAt)
        .slice()
        .reverse()
    : [];
  send(res, 200, { notifications });
}
async function reimbursementHistory(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const account = (await users()).find(entry => entry.id === user.id);
  const reimbursements = (Array.isArray(account?.notifications) ? account.notifications : [])
    .filter(item => item?.type === 'reimbursement')
    .sort((left, right) => String(right.sentAt || '').localeCompare(String(left.sentAt || '')));
  send(res, 200, { reimbursements });
}
async function reimbursementCandidates(req, res, userId) {
  if (!requireUser(req, res, 'super')) return;
  const people = await users(),
    target = people.find(user => user.id === userId && user.role === 'regular');
  if (!target) return send(res, 404, { error: 'Regular user not found.' });
  const eligible = (await expenses())
    .filter(
      expense =>
        expense.userId === userId &&
        expense.reviewStatus === 'approved' &&
        !expense.reimbursementId &&
        !isCompanyPaid(expense)
    )
    .map(publicExpense);
  send(res, 200, { user: publicUser(target), expenses: eligible });
}
// One reimbursement with the expenses it paid, for the printable detail page.
async function reimbursementDetail(req, res, userId, reimbursementId) {
  if (!requireUser(req, res, 'super')) return;
  const target = (await users()).find(user => user.id === userId);
  const reimbursement = (Array.isArray(target?.notifications) ? target.notifications : []).find(
    item => item?.type === 'reimbursement' && item.id === reimbursementId
  );
  if (!reimbursement) return send(res, 404, { error: 'Reimbursement not found.' });
  const ids = Array.isArray(reimbursement.expenseIds) ? reimbursement.expenseIds : [];
  const byId = new Map(
    (await expenses())
      .filter(expense => expense.userId === userId && ids.includes(expense.id))
      .map(expense => [expense.id, expense])
  );
  send(res, 200, {
    reimbursement,
    user: publicUser(target),
    expenses: ids
      .filter(id => byId.has(id))
      .map(id => publicExpense(byId.get(id)))
      .sort((left, right) => String(left.date).localeCompare(String(right.date))),
    // Expenses deleted after the reimbursement was sent.
    missing: ids.filter(id => !byId.has(id)).length
  });
}
async function createReimbursementBatch(req, res, userId) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const input = await jsonBody(req),
      expenseIds = Array.isArray(input.expenseIds) ? [...new Set(input.expenseIds)] : [];
    const paymentDate = typeof input.paymentDate === 'string' ? input.paymentDate : '';
    const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (
      !expenseIds.length ||
      expenseIds.length > 100 ||
      expenseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id))
    )
      return send(res, 400, { error: 'Select between 1 and 100 approved expenses.' });
    if (!validDate(paymentDate)) return send(res, 400, { error: 'Choose a valid payment date.' });
    if (!reference || reference.length > 80)
      return send(res, 400, { error: 'Enter a payment reference of up to 80 characters.' });
    if (!message || message.length > textLimits.message)
      return send(res, 400, { error: 'Enter a reimbursement message of up to 300 characters.' });
    const people = await users(),
      target = people.find(user => user.id === userId && user.role === 'regular');
    if (!target) return send(res, 404, { error: 'Regular user not found.' });
    const allExpenses = await expenses(),
      selected = expenseIds.map(id => allExpenses.find(expense => expense.id === id));
    const invalid = selected.some(
      expense =>
        !expense ||
        expense.userId !== userId ||
        expense.reviewStatus !== 'approved' ||
        expense.reimbursementId ||
        isCompanyPaid(expense)
    );
    if (invalid)
      return send(res, 409, {
        error: 'One or more selected expenses are no longer eligible. Nothing was sent.'
      });
    const reimbursementId = randomBytes(12).toString('hex'),
      sentAt = new Date().toISOString();
    const amount =
      Math.round(selected.reduce((sum, expense) => sum + Number(expense.amount || 0), 0) * 100) /
      100;
    const notification = {
      id: reimbursementId,
      type: 'reimbursement',
      message,
      amount,
      currency: 'EUR',
      paymentDate,
      reference,
      expenseIds,
      expenseCount: selected.length,
      sentAt,
      sentBy: actor.fullName || actor.email
    };
    target.notifications = [
      ...(Array.isArray(target.notifications) ? target.notifications : []),
      notification
    ].slice(-50);
    for (const expense of selected)
      Object.assign(expense, {
        reimbursementId,
        reimbursedAt: sentAt,
        reimbursementPaymentDate: paymentDate,
        reimbursementReference: reference
      });
    await saveUsers(people);
    await saveExpenses(allExpenses);
    await audit('reimbursement_batch_sent', {
      actorId: actor.id,
      targetUserId: target.id,
      reimbursementId,
      expenseIds,
      expenseCount: selected.length,
      amount,
      paymentDate,
      reference
    });
    send(res, 201, { reimbursement: notification });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function sendReimbursementNotification(req, res, userId) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  try {
    const input = await jsonBody(req);
    const all = await users();
    const target = all.find(user => user.id === userId && user.role === 'regular');
    if (!target) return send(res, 404, { error: 'Regular user not found.' });
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    const amount = input.amount === '' || input.amount === undefined ? null : Number(input.amount);
    if (!message || message.length > 300)
      return send(res, 400, { error: 'Enter a reimbursement message of up to 300 characters.' });
    if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000))
      return send(res, 400, { error: 'Enter a valid reimbursement amount.' });
    const notification = {
      id: randomBytes(12).toString('hex'),
      type: 'reimbursement',
      message,
      amount,
      currency: 'EUR',
      sentAt: new Date().toISOString(),
      sentBy: actor.fullName || actor.email
    };
    target.notifications = [
      ...(Array.isArray(target.notifications) ? target.notifications : []),
      notification
    ].slice(-50);
    await saveUsers(all);
    await audit('reimbursement_notification_sent', {
      actorId: actor.id,
      targetUserId: target.id,
      notificationId: notification.id
    });
    send(res, 201, { notification });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function dismissNotification(req, res, id) {
  const user = requireUser(req, res);
  if (!user) return;
  const all = await users();
  const account = all.find(entry => entry.id === user.id);
  const notification = account?.notifications?.find(item => item.id === id);
  if (!notification || notification.dismissedAt)
    return send(res, 404, { error: 'Notification not found.' });
  notification.dismissedAt = new Date().toISOString();
  await saveUsers(all);
  send(res, 200, { ok: true });
}
async function deleteUser(req, res, id) {
  const actor = requireUser(req, res, 'super');
  if (!actor) return;
  const all = await users();
  const target = all.find(user => user.id === id);
  if (!target || target.role !== 'regular')
    return send(res, 404, { error: 'Regular user not found.' });
  const records = await expenses();
  const removed = records.filter(expense => expense.userId === id);
  await saveUsers(all.filter(user => user.id !== id));
  await saveExpenses(records.filter(expense => expense.userId !== id));
  await Promise.all(removed.map(expense => removeReceipt(expense.receiptFile)));
  invalidateUserSessions(id);
  await audit('user_deleted', {
    actorId: actor.id,
    targetUserId: id,
    expensesDeleted: removed.length
  });
  send(res, 200, { ok: true });
}
async function updateUser(req, res, id) {
  const editor = requireUser(req, res);
  if (!editor) return;
  if (editor.role !== 'super')
    return send(res, 403, { error: 'Only a Super User can change profiles.' });
  try {
    const input = await jsonBody(req);
    const all = await users();
    const target = all.find(user => user.id === id);
    if (!target) return send(res, 404, { error: 'User not found.' });

    const editingSelf = editor.id === target.id;
    const editingEmployee = target.role !== 'super';
    if (!editingSelf && !editingEmployee)
      return send(res, 403, {
        error: 'You can only edit your own profile or an eligible employee profile.'
      });

    const clean = (value, limit) =>
      typeof value === 'string' && value.trim().length <= limit ? value.trim() : null;
    const fullName = clean(input.fullName, textLimits.fullName);
    const jobDescription = clean(input.jobDescription, textLimits.jobDescription);
    const carRegistration = clean(input.carRegistration, textLimits.carRegistration);
    if (!fullName || jobDescription === null || carRegistration === null)
      return send(res, 400, { error: 'Profile details are invalid.' });
    const employeeCode =
      input.employeeCode === undefined
        ? target.employeeCode || ''
        : cleanEmployeeCode(input.employeeCode);
    if (employeeCode === null)
      return send(res, 400, {
        error: 'Employee codes use up to 20 letters, numbers or hyphens.'
      });
    if (employeeCodeTaken(all, employeeCode, target.id))
      return send(res, 409, { error: 'Another account already uses that employee code.' });

    let reloginRequired = false;
    if (editingSelf) {
      const email = cleanEmail(input.email);
      const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
      const changingCredentials = email !== target.email || Boolean(newPassword);
      if (!validEmail(email))
        return send(res, 400, { error: 'Enter a valid email address of up to 254 characters.' });
      if (changingCredentials) {
        if (!passwordMatches(input.currentPassword || '', target.passwordHash))
          return send(res, 403, {
            error: 'Enter your current password to change your email or password.'
          });
        if (newPassword && !validatePassword(newPassword))
          return send(res, 400, { error: 'New password must contain 12–128 characters.' });
        if (
          email !== target.email &&
          all.some(user => user.id !== target.id && user.email === email)
        )
          return send(res, 409, { error: 'That email already has an account.' });
        target.email = email;
        if (newPassword) target.passwordHash = hashPassword(newPassword);
        reloginRequired = true;
      }
      if (editor.role === 'super' && input.department !== undefined) {
        if (!departments.includes(input.department))
          return send(res, 400, { error: 'Choose a valid department.' });
        target.department = input.department;
      }
    } else if (editor.role === 'super') {
      if (!departments.includes(input.department))
        return send(res, 400, { error: 'Choose a valid department.' });
      if (input.mileageEnabled !== undefined && typeof input.mileageEnabled !== 'boolean')
        return send(res, 400, { error: 'Mileage allocation is invalid.' });
      if (input.engineBand !== undefined && !validEngineBand(input.engineBand))
        return send(res, 400, { error: 'Choose a valid engine size.' });
      target.department = input.department;
      if (input.mileageEnabled !== undefined) target.mileageEnabled = input.mileageEnabled;
      if (input.engineBand !== undefined) target.engineBand = input.engineBand;
    }

    target.fullName = fullName;
    target.jobDescription = jobDescription;
    target.carRegistration = carRegistration;
    target.employeeCode = employeeCode;
    target.updatedAt = new Date().toISOString();
    await saveUsers(all);
    if (!editingSelf || reloginRequired) invalidateUserSessions(id);
    else refreshUserSessions(target);
    await audit(editingSelf ? 'profile_updated' : 'user_updated', {
      actorId: editor.id,
      targetUserId: id,
      credentialsChanged: reloginRequired
    });
    send(res, 200, { user: publicUser(target), reloginRequired });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
}
async function receiptAccess(req, res, id) {
  const viewer = requireUser(req, res);
  if (!viewer) return null;
  const expense = (await expenses()).find(record => record.id === id);
  if (!expense) {
    send(res, 404, { error: 'Expense not found.' });
    return null;
  }
  if (!(await canViewExpense(viewer, expense))) {
    send(res, 403, { error: 'You do not have access to this receipt.' });
    return null;
  }
  if (!expense.receiptFile) {
    send(res, 404, { error: 'No receipt is attached to this expense.' });
    return null;
  }
  const match = /^([a-f0-9]{32})\.(jpg|png|webp|pdf)$/.exec(expense.receiptFile);
  if (!match) {
    send(res, 404, { error: 'Receipt file is unavailable.' });
    return null;
  }
  return { expense, extension: match[2], path: join(receiptsDir, expense.receiptFile) };
}
async function sendResolvedReceipt(res, receipt, download = false) {
  const typesByExtension = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf'
  };
  try {
    const content = await readFile(receipt.path);
    const filename = `oxygen-care-receipt-${receipt.expense.date || 'record'}.${receipt.extension}`;
    res.writeHead(200, {
      'Content-Type': typesByExtension[receipt.extension],
      'Content-Length': content.length,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  } catch {
    send(res, 404, { error: 'Receipt file is unavailable.' });
  }
}
async function sendReceiptFile(req, res, id, download = false) {
  const receipt = await receiptAccess(req, res, id);
  if (receipt) await sendResolvedReceipt(res, receipt, download);
}
function receiptReturnPath(req) {
  const requested = new URL(req.url, 'http://local').searchParams.get('returnTo') || '/';
  try {
    const target = new URL(requested, 'http://local');
    const allowed = new Set([
      '/',
      '/reports.html',
      '/review.html',
      '/review-head.html',
      '/expense-detail.html',
      '/batch-approve.html'
    ]);
    return target.origin === 'http://local' && allowed.has(target.pathname)
      ? `${target.pathname}${target.search}`
      : '/';
  } catch {
    return '/';
  }
}
function htmlAttribute(value) {
  return String(value).replace(
    /[&"<>]/g,
    character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]
  );
}
function runPdfTool(command, args, maximumBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const output = [],
      errors = [];
    let outputBytes = 0,
      settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(output));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('PDF preview timed out.'));
    }, 20_000);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maximumBytes) {
        child.kill('SIGKILL');
        finish(new Error('PDF preview is too large.'));
      } else output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (Buffer.concat(errors).length < 4096) errors.push(chunk);
    });
    child.on('error', error =>
      finish(
        new Error(
          error.code === 'ENOENT'
            ? 'PDF preview support is not installed.'
            : 'PDF preview could not start.'
        )
      )
    );
    child.on('close', code =>
      finish(
        code === 0
          ? null
          : new Error(
              Buffer.concat(errors).toString('utf8').trim() || 'PDF preview could not be created.'
            )
      )
    );
  });
}
async function pdfPageCount(path) {
  const information = (await runPdfTool('pdfinfo', [path])).toString('utf8');
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(information)?.[1]);
  if (!Number.isInteger(pages) || pages < 1 || pages > pdfPreviewMaxPages)
    throw new Error(`PDF receipts must contain 1-${pdfPreviewMaxPages} pages.`);
  return pages;
}
function receiptViewerPage(id, extension, returnPath, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt</title><style>body{margin:0;background:#dfe8eb;color:#183f4b;font:16px system-ui,-apple-system,Segoe UI,sans-serif}.bar{position:sticky;z-index:1;top:0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;background:#fff;border-bottom:1px solid #bdd5dc}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.bar a,.bar button{padding:9px 12px;border:1px solid #277b91;border-radius:8px;background:#277b91;color:#fff;font:inherit;font-weight:750;text-decoration:none}.bar a.back{background:#fff;color:#277b91}.bar button:disabled{opacity:.65}.image{display:block;box-sizing:border-box;width:auto;max-width:100%;height:auto;max-height:calc(100vh - 75px);margin:auto;padding:14px;object-fit:contain}.pages{display:grid;gap:14px;padding:14px}.pages img{display:block;width:min(100%,1000px);height:auto;margin:auto;background:#fff;box-shadow:0 2px 12px #183f4b33}</style></head><body><header class="bar"><strong>Receipt</strong><nav class="actions" aria-label="Receipt actions"><a class="back" href="${returnPath}">Back</a><button id="save" type="button">Save / Share</button></nav></header>${content}<script>document.querySelector('.back').addEventListener('click',event=>{event.preventDefault();location.replace(event.currentTarget.href)});document.getElementById('save').addEventListener('click',async event=>{const button=event.currentTarget,original=button.textContent;button.disabled=true;button.textContent='Preparing…';try{const response=await fetch('/api/expenses/${id}/receipt/download',{credentials:'same-origin'});if(!response.ok)throw new Error();const blob=await response.blob(),file=new File([blob],'oxygen-care-receipt.${extension}',{type:blob.type});if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]})))await navigator.share({files:[file],title:'Expense receipt'});else{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}}catch(error){if(error.name!=='AbortError')alert('The receipt could not be prepared. Please try again.')}finally{button.disabled=false;button.textContent=original}})</script></body></html>`;
}
function sendReceiptViewer(res, page, nonce) {
  const securedPage = page.replace(/<(script|style)(?=[\s>])/gi, `<$1 nonce="${nonce}"`);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    ...securityHeaders(nonce)
  });
  res.end(securedPage);
}
async function viewReceipt(req, res, id) {
  const receipt = await receiptAccess(req, res, id);
  if (!receipt) return;
  const nonce = requestNonce();
  const returnPath = htmlAttribute(receiptReturnPath(req));
  if (receipt.extension !== 'pdf') {
    return sendReceiptViewer(
      res,
      receiptViewerPage(
        id,
        receipt.extension,
        returnPath,
        `<img class="image" src="/api/expenses/${id}/receipt/content" alt="Expense receipt">`
      ),
      nonce
    );
  }
  try {
    const pages = await pdfPageCount(receipt.path);
    const images = Array.from(
      { length: pages },
      (_, index) =>
        `<img src="/api/expenses/${id}/receipt/preview/${index + 1}" alt="Receipt page ${index + 1}">`
    ).join('');
    sendReceiptViewer(
      res,
      receiptViewerPage(id, 'pdf', returnPath, `<main class="pages">${images}</main>`),
      nonce
    );
  } catch (error) {
    send(res, 422, { error: error.message });
  }
}
async function viewReceiptPreview(req, res, id, page) {
  const receipt = await receiptAccess(req, res, id);
  if (!receipt) return;
  const pageNumber = Number(page);
  if (
    receipt.extension !== 'pdf' ||
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > pdfPreviewMaxPages
  )
    return send(res, 404, { error: 'Receipt preview is unavailable.' });
  if (pdfPreviewInFlight >= pdfPreviewMaxConcurrent)
    return send(
      res,
      429,
      { error: 'Receipt preview is busy. Please try again.' },
      { 'Retry-After': '2' }
    );
  pdfPreviewInFlight += 1;
  let temporaryDirectory = '';
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'oxygen-receipt-preview-'));
    const outputPrefix = join(temporaryDirectory, 'page');
    await runPdfTool('pdftoppm', [
      '-f',
      String(pageNumber),
      '-l',
      String(pageNumber),
      '-singlefile',
      '-scale-to',
      '1800',
      '-png',
      receipt.path,
      outputPrefix
    ]);
    const image = await readFile(`${outputPrefix}.png`);
    if (
      image.length < 8 ||
      image.length > 12 * 1024 * 1024 ||
      !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('PDF preview output is invalid.');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': image.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(image);
  } catch (error) {
    send(res, 422, { error: error.message });
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    pdfPreviewInFlight = Math.max(0, pdfPreviewInFlight - 1);
  }
}
function receiptResponse({
  merchant = '',
  amount = null,
  date = '',
  category = 'Other',
  note = ''
}) {
  const numericAmount = Number(amount);
  return {
    merchant: typeof merchant === 'string' ? merchant.slice(0, 120) : '',
    amount: Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayLocal(),
    category: categories.includes(category) ? category : 'Other',
    note: typeof note === 'string' ? note.slice(0, 300) : '',
    currency: 'EUR'
  };
}
function azureField(fields, name) {
  const field = fields?.[name];
  if (!field) return '';
  return (
    field.valueCurrency?.amount ??
    field.valueNumber ??
    field.valueDate ??
    field.valueString ??
    field.content ??
    ''
  );
}
function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError')
      throw new Error('Receipt service timed out. Please enter it manually.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function scanWithAzure(image, mediaType) {
  if (process.env.OCR_ALLOW_CLOUD !== 'true')
    throw new Error('Cloud receipt processing is disabled. Please enter it manually.');
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.replace(/\/+$/, '');
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  if (!endpoint || !key) throw new Error('Azure Document Intelligence is not configured.');
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password)
    throw new Error('Azure requires a secure HTTPS endpoint.');
  if (mediaType === 'image/webp')
    throw new Error(
      'Azure receipt scanning supports JPEG or PNG images. Please choose a JPEG or PNG receipt.'
    );
  const start = await fetchWithTimeout(
    `${endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Ocp-Apim-Subscription-Key': key },
      body: JSON.stringify({ base64Source: image })
    }
  );
  if (!start.ok) {
    console.error('Azure Document Intelligence error', start.status);
    throw new Error('Receipt service is unavailable. Please enter it manually.');
  }
  const operation = start.headers.get('operation-location');
  if (!operation) throw new Error('Receipt service did not return an operation to check.');
  let operationUrl;
  try {
    operationUrl = new URL(operation);
    const configuredUrl = new URL(endpoint);
    if (operationUrl.protocol !== 'https:' || operationUrl.origin !== configuredUrl.origin)
      throw new Error();
  } catch {
    throw new Error('Receipt service returned an unsafe operation address.');
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(1000);
    const result = await fetchWithTimeout(operationUrl, {
      headers: { 'Ocp-Apim-Subscription-Key': key }
    });
    if (!result.ok) {
      console.error('Azure Document Intelligence status error', result.status);
      throw new Error('Receipt service is unavailable. Please enter it manually.');
    }
    const payload = await result.json();
    if (payload.status === 'succeeded') {
      const fields = payload.analyzeResult?.documents?.[0]?.fields || {};
      return receiptResponse({
        merchant: azureField(fields, 'MerchantName'),
        amount: azureField(fields, 'Total'),
        date: azureField(fields, 'TransactionDate'),
        note: azureField(fields, 'ReceiptType')
      });
    }
    if (payload.status === 'failed')
      throw new Error('Azure could not read that receipt. Please enter it manually.');
  }
  throw new Error('Receipt scanning timed out. Please enter it manually.');
}
function amountFromText(value) {
  const digits = String(value).replace(/[^0-9,.]/g, '');
  // The last separator followed by exactly two digits is the decimal point, so both
  // 1,245.00 and 1.245,00 read as 1245; any other separators group thousands.
  const decimal = /[,.](\d{2})$/.exec(digits);
  const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(/[,.]/g, '');
  const numeric = Number(`${whole}${decimal ? `.${decimal[1]}` : ''}`);
  return whole && Number.isFinite(numeric) && numeric > 0 && numeric <= 1_000_000 ? numeric : null;
}
// Matches 12.50, 6,75, €1,245.00, 1.245,00 and EUR 12; whole numbers only count when
// the caller allows them, so quantities and reference numbers are not taken as totals.
const receiptAmountPattern = /(?:€|EUR)?\s*(?:\d{1,3}(?:[,.]\d{3})+|\d+)(?:[,.]\d{2})?(?!\d)/gi;
const receiptTotalLine =
  /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|to\s*pay|total)(?![a-z])/i;
const receiptNotTotalLine =
  /\b(sub\s*-?\s*total|total\s*(items?|qty|quantity|savings?|saved|discount|vat|tax)|vat\s*total|tax\s*total)(?![a-z])/i;
function receiptAmounts(line, { allowWhole = false } = {}) {
  // Dates such as 14.10.2026 would otherwise read as the amount 14.10.
  const withoutDates = line.replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ');
  return (withoutDates.match(receiptAmountPattern) || [])
    .filter(match => allowWhole || /[,.]\d{2}$/.test(match.trim()))
    .map(amountFromText)
    .filter(Boolean);
}
function receiptTotal(lines) {
  for (const [index, line] of lines.entries()) {
    if (!receiptTotalLine.test(line) || receiptNotTotalLine.test(line)) continue;
    // Receipts often print the amount on the total line or on the line below it.
    const amount =
      receiptAmounts(line, { allowWhole: true })[0] ||
      (lines[index + 1] && !/[A-Za-z]{3}/.test(lines[index + 1])
        ? receiptAmounts(lines[index + 1], { allowWhole: true })[0]
        : null);
    if (amount) return amount;
  }
  // Without a readable total line, the largest priced amount is usually the total.
  const amounts = lines.flatMap(line => receiptAmounts(line));
  return amounts.length ? Math.max(...amounts) : null;
}
function dateFromTesseract(text) {
  const iso = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/.exec(text);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const european =
    /\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})(?=\D|$|\d{1,2}:\d{2})/.exec(text);
  return european
    ? `${european[3]}-${String(european[2]).padStart(2, '0')}-${String(european[1]).padStart(2, '0')}`
    : '';
}
function categoryFromTesseract(text) {
  const value = text.toLowerCase();
  const guesses = [
    ['Fuel', /\b(fuel|diesel|petrol|service station)\b/],
    ['Food', /\b(cafe|restaurant|grocery|supermarket|food)\b/],
    ['Travel', /\b(taxi|hotel|parking|train|bus|airline)\b/],
    ['Office', /\b(stationery|office|printing)\b/],
    ['Software', /\b(software|subscription|license)\b/]
  ];
  return guesses.find(([, pattern]) => pattern.test(value))?.[0] || 'Other';
}
function parseTesseractReceipt(text) {
  const lines = text
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/\s+/g, ' ')
        // OCR often adds a space inside numbers, e.g. "€1, 245.00" or "12 .50".
        .replace(/(\d[,.]) (?=\d)/g, '$1')
        .replace(/(\d) (?=[,.]\d)/g, '$1')
        // ...or misreads the decimal point as a similar mark, e.g. "17°49".
        .replace(/(\d)[°'’`´·](\d{2})(?!\d)/g, '$1.$2')
        .trim()
    )
    .filter(Boolean);
  const amount = receiptTotal(lines);
  const itemAmounts = lines
    .filter(line => !receiptTotalLine.test(line))
    .flatMap(line => receiptAmounts(line));
  const merchant =
    lines
      .find(
        line =>
          /[A-Za-z]{3}/.test(line) &&
          !/\b(receipt|invoice|total|tax|vat|date|cash|change)\b/i.test(line)
      )
      ?.slice(0, 120) || '';
  return {
    merchant,
    amount,
    date: dateFromTesseract(text),
    category: categoryFromTesseract(text),
    note: '',
    // A total below an item price means part of the receipt was misread.
    totalBelowItem: Boolean(amount && itemAmounts.some(item => item > amount))
  };
}
// Runs a local OCR program that reads the image on stdin and prints text on stdout.
// `deadline` (a Date.now() time) cuts the run short so the whole scan fits the proxy timeout.
function runOcrProcess(label, command, args, bytes, deadline = Infinity) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '',
      timedOut = false,
      tooLarge = false;
    const timer = setTimeout(
      () => {
        // Answer at the deadline even if a helper process still holds the output pipe open.
        timedOut = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
        reject(new Error(`${label} timed out.`));
      },
      Math.max(1000, Math.min(upstreamTimeoutMs, 30_000, deadline - Date.now()))
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) {
        tooLarge = true;
        child.kill('SIGKILL');
        child.stdout.destroy();
      }
    });
    // The program can exit before reading all of stdin; an unhandled EPIPE here would crash the whole server.
    child.stdin.on('error', () => {});
    child.on('error', error => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `${label} is not installed on this server.`
            : `${label} could not start.`
        )
      );
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (tooLarge || code !== 0) return reject(new Error(`${label} could not read this receipt.`));
      resolve(output);
    });
    child.stdin.end(bytes);
  });
}
function tesseractText(bytes, pageSegmentationMode = '6', deadline) {
  return runOcrProcess(
    'Tesseract OCR',
    'tesseract',
    ['stdin', 'stdout', '-l', 'eng', '--psm', pageSegmentationMode],
    bytes,
    deadline
  );
}
// RapidOCR (default) and PaddleOCR (fallback) each live in their own Python environment,
// installed by scripts/remote-update.sh; set RAPIDOCR_PYTHON or PADDLEOCR_PYTHON to off to
// disable one.
const rapidOcrPython =
  process.env.RAPIDOCR_PYTHON || '/home/serveradmin/oxygen-care-expenses-rapidocr/bin/python3';
const paddleOcrPython =
  process.env.PADDLEOCR_PYTHON || '/home/serveradmin/oxygen-care-expenses-paddleocr/bin/python3';
function rapidOcrText(bytes, deadline) {
  return runOcrProcess(
    'RapidOCR',
    rapidOcrPython,
    ['-I', join(process.cwd(), 'scripts', 'rapidocr_text.py')],
    bytes,
    deadline
  );
}
function paddleOcrText(bytes, deadline) {
  return runOcrProcess(
    'PaddleOCR',
    paddleOcrPython,
    ['-I', join(process.cwd(), 'scripts', 'paddleocr_text.py')],
    bytes,
    deadline
  );
}
async function localOcrVariants(bytes) {
  const base = sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1 });
  const primary = await base.clone().png({ compressionLevel: 9 }).toBuffer();
  const highContrast = await base
    .clone()
    .linear(1.2, -18)
    .threshold(180)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return [primary, highContrast];
}
function tesseractResultScore(result) {
  return (
    (result.merchant ? 2 : 0) +
    (result.amount ? (result.totalBelowItem ? 1 : 2) : 0) +
    (result.date ? 1 : 0)
  );
}
async function scanWithTesseract(bytes, deadline) {
  const [primaryImage, retryImage] = await localOcrVariants(bytes);
  const primary = parseTesseractReceipt(await tesseractText(primaryImage, '6', deadline));
  let best = primary;
  if (tesseractResultScore(primary) < 5) {
    const retry = parseTesseractReceipt(await tesseractText(retryImage, '4', deadline));
    if (tesseractResultScore(retry) > tesseractResultScore(primary)) best = retry;
  }
  if (!best.merchant || !best.amount)
    throw new Error('Tesseract OCR could not confidently read this receipt.');
  return receiptResponse(best);
}
async function scanWithPython(label, python, readText, bytes, deadline) {
  if (python === 'off') throw new Error(`${label} is turned off on this server.`);
  const result = parseTesseractReceipt(await readText(bytes, deadline));
  if (!result.merchant || !result.amount)
    throw new Error(`${label} could not confidently read this receipt.`);
  return receiptResponse(result);
}
// Local receipt readers, tried in order until one reads the merchant and total.
// Tesseract stays as a last resort because it is already installed and cheap to run.
const localOcrEngines = [
  {
    name: 'rapidocr',
    scan: (bytes, deadline) =>
      scanWithPython('RapidOCR', rapidOcrPython, rapidOcrText, bytes, deadline)
  },
  {
    name: 'paddleocr',
    scan: (bytes, deadline) =>
      scanWithPython('PaddleOCR', paddleOcrPython, paddleOcrText, bytes, deadline)
  },
  { name: 'tesseract', scan: scanWithTesseract }
];
async function scanReceipt(req, res) {
  const user = requireUser(req, res);
  if (!user || !rateLimit(req, res, 'ocr', ocrLimit, 15 * 60_000)) return;
  const usageKey = `${new Date().toISOString().slice(0, 10)}:${user.id}`;
  const used = ocrUsage.get(usageKey) || 0;
  if (used >= ocrDailyLimit)
    return send(res, 429, {
      error:
        'Your daily receipt scanning limit has been reached. Please enter the expense manually.'
    });
  if (ocrInFlight >= ocrMaxConcurrent)
    return send(
      res,
      429,
      { error: 'Receipt scanning is busy. Please try again shortly.' },
      { 'Retry-After': '10' }
    );
  ocrInFlight += 1;
  try {
    const { image, mediaType } = await jsonBody(req);
    if (!ocrImageTypes.has(mediaType))
      return send(res, 400, { error: 'Use a JPEG, PNG, or WebP image.' });
    const receipt = await prepareReceipt(validatedReceipt({ image, mediaType }));
    const bytes = receipt.bytes;
    const preparedImage = bytes.toString('base64');
    // 'tesseract' is the setting's old name for local scanning; existing .env files keep working.
    const provider = (process.env.OCR_PROVIDER || 'local').toLowerCase();
    if (provider === 'local' || provider === 'tesseract') {
      const failures = [],
        // Nginx waits 60 seconds; leave room to answer before it gives up.
        deadline = Date.now() + 50_000;
      for (const engine of localOcrEngines) {
        if (deadline - Date.now() < 3000) break;
        try {
          const result = await engine.scan(bytes, deadline);
          ocrUsage.set(usageKey, used + 1);
          await audit(
            failures.length ? 'ocr_fallback_succeeded' : 'ocr_succeeded',
            failures.length
              ? {
                  userId: user.id,
                  primaryProvider: localOcrEngines[0].name,
                  fallbackProvider: engine.name
                }
              : { userId: user.id, provider: engine.name }
          );
          return send(res, 200, result);
        } catch (error) {
          failures.push(error.message);
        }
      }
      try {
        const result = await scanWithAzure(preparedImage, 'image/jpeg');
        ocrUsage.set(usageKey, used + 1);
        await audit('ocr_fallback_succeeded', {
          userId: user.id,
          primaryProvider: localOcrEngines[0].name,
          fallbackProvider: 'azure'
        });
        return send(res, 200, result);
      } catch (azureError) {
        console.error('Local OCR and Azure OCR failed', ...failures, azureError.message);
        // With cloud fallback off, show the local reasons (e.g. RapidOCR not installed)
        // instead of a generic message, so the cause is visible without the server log.
        const cloudUnused = process.env.OCR_ALLOW_CLOUD !== 'true';
        const localReasons = failures.filter(message =>
          /^(RapidOCR|PaddleOCR|Tesseract OCR) /.test(message)
        );
        throw new Error(
          cloudUnused && localReasons.length
            ? `${localReasons.join(' ')} Please enter it manually.`
            : 'Receipt could not be read automatically. Please enter it manually.'
        );
      }
    }
    if (provider === 'azure') {
      const result = await scanWithAzure(preparedImage, 'image/jpeg');
      ocrUsage.set(usageKey, used + 1);
      await audit('ocr_succeeded', { userId: user.id, provider: 'azure' });
      return send(res, 200, result);
    }
    return send(res, 503, { error: 'OCR_PROVIDER must be local or azure.' });
  } catch (error) {
    console.error('OCR failure', error.message);
    await audit('ocr_failed', {
      userId: user.id,
      reason: String(error.message || 'unknown').slice(0, 120)
    });
    const message =
      error.message === 'Azure Document Intelligence is not configured.'
        ? 'OCR is not configured on this server.'
        : error.message || 'Couldn’t read that receipt. Please enter it manually.';
    send(res, 400, { error: message });
  } finally {
    ocrInFlight = Math.max(0, ocrInFlight - 1);
  }
}

await loadSettings();
await bootstrapSuperUser();
async function routeRequest(req, res) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (req.method === 'GET' && pathname === '/logout') return logoutAndRedirect(req, res);
  if (
    pathname.startsWith('/api/') &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    !requireSameOrigin(req, res)
  )
    return;
  if (req.method === 'POST' && pathname === '/api/auth/login') return login(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/verify') return verifySignIn(req, res);
  if (
    pathname.startsWith('/api/') &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    !requireCsrf(req, res)
  )
    return;
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = cookieValue(req, 'oc_session');
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookies() });
  }
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = sessionUser(req);
    return user
      ? send(res, 200, { user, idleTimeoutMinutes: sessionIdleMinutes })
      : send(res, 401, { error: 'Please sign in.' }, { 'Set-Cookie': clearCookies() });
  }
  if (req.method === 'GET' && pathname === '/api/settings') return appSettings(req, res);
  if (req.method === 'POST' && pathname === '/api/settings/categories')
    return addSetting(req, res, 'category');
  if (req.method === 'POST' && pathname === '/api/settings/departments')
    return addSetting(req, res, 'department');
  if (req.method === 'PATCH' && pathname === '/api/settings/categories')
    return updateCategory(req, res);
  if (req.method === 'PUT' && pathname === '/api/settings/cutoff')
    return setExpenseCutoff(req, res);
  if (req.method === 'DELETE' && pathname === '/api/settings/categories')
    return removeSetting(req, res, 'category');
  if (req.method === 'DELETE' && pathname === '/api/settings/departments')
    return removeSetting(req, res, 'department');
  if (req.method === 'GET' && pathname === '/api/dashboard/expenses')
    return dashboardExpenses(req, res);
  if (req.method === 'GET' && pathname === '/api/dashboard/approvals')
    return dashboardApprovals(req, res);
  if (req.method === 'GET' && pathname === '/api/reports/expenses') return reportExpenses(req, res);
  if (req.method === 'GET' && pathname === '/api/reports/odometer') return reportOdometer(req, res);
  if (req.method === 'GET' && pathname === '/api/reports/reimbursements')
    return reportReimbursements(req, res);
  if (req.method === 'GET' && pathname === '/api/audit') return activityLog(req, res);
  if (req.method === 'GET' && pathname === '/api/users') return listUsers(req, res);
  if (req.method === 'POST' && pathname === '/api/users') return createUser(req, res);
  if (req.method === 'GET' && pathname === '/api/super-users') return listSuperUsers(req, res);
  if (req.method === 'GET' && pathname === '/api/department-heads')
    return listDepartmentHeads(req, res);
  const superUserMatch = pathname.match(/^\/api\/super-users\/([A-Za-z0-9]+)$/);
  if (req.method === 'PATCH' && superUserMatch) return manageSuperUser(req, res, superUserMatch[1]);
  const departmentHeadMatch = pathname.match(/^\/api\/department-heads\/([A-Za-z0-9]+)$/);
  if (req.method === 'PATCH' && departmentHeadMatch)
    return manageDepartmentHead(req, res, departmentHeadMatch[1]);
  if (req.method === 'GET' && pathname === '/api/notifications') return listNotifications(req, res);
  if (req.method === 'GET' && pathname === '/api/reimbursements/mine')
    return reimbursementHistory(req, res);
  const reimbursementCandidatesMatch = pathname.match(
    /^\/api\/users\/([A-Za-z0-9]+)\/reimbursement-candidates$/
  );
  if (req.method === 'GET' && reimbursementCandidatesMatch)
    return reimbursementCandidates(req, res, reimbursementCandidatesMatch[1]);
  const reimbursementDetailMatch = pathname.match(
    /^\/api\/users\/([A-Za-z0-9]+)\/reimbursements\/([A-Za-z0-9]+)$/
  );
  if (req.method === 'GET' && reimbursementDetailMatch)
    return reimbursementDetail(req, res, reimbursementDetailMatch[1], reimbursementDetailMatch[2]);
  const reimbursementBatchMatch = pathname.match(/^\/api\/users\/([A-Za-z0-9]+)\/reimbursements$/);
  if (req.method === 'POST' && reimbursementBatchMatch)
    return createReimbursementBatch(req, res, reimbursementBatchMatch[1]);
  const reimbursementMatch = pathname.match(
    /^\/api\/users\/([A-Za-z0-9]+)\/reimbursement-notifications$/
  );
  if (req.method === 'POST' && reimbursementMatch)
    return sendReimbursementNotification(req, res, reimbursementMatch[1]);
  const notificationMatch = pathname.match(/^\/api\/notifications\/([A-Za-z0-9]+)$/);
  if (req.method === 'PATCH' && notificationMatch)
    return dismissNotification(req, res, notificationMatch[1]);
  const mfaResetMatch = pathname.match(/^\/api\/users\/([A-Za-z0-9]+)\/mfa$/);
  if (req.method === 'DELETE' && mfaResetMatch)
    return resetAuthenticator(req, res, mfaResetMatch[1]);
  const userMatch = pathname.match(/^\/api\/users\/([A-Za-z0-9]+)$/);
  if (req.method === 'PATCH' && userMatch) return updateUser(req, res, userMatch[1]);
  if (req.method === 'DELETE' && userMatch) return deleteUser(req, res, userMatch[1]);
  if (req.method === 'GET' && pathname === '/api/expenses') return listExpenses(req, res);
  if (req.method === 'GET' && pathname === '/api/odometer/month') return monthlyOdometer(req, res);
  if (req.method === 'POST' && pathname === '/api/odometer/month')
    return saveMonthlyOdometer(req, res);
  if (req.method === 'GET' && pathname === '/api/mileage/month') return monthlyMileage(req, res);
  if (req.method === 'POST' && pathname === '/api/mileage/month')
    return saveMonthlyMileage(req, res);
  if (req.method === 'POST' && pathname === '/api/expenses') return createExpense(req, res);
  if (req.method === 'POST' && pathname === '/api/expenses/batch-approve')
    return batchApproveExpenses(req, res);
  const receiptDownloadMatch = pathname.match(
    /^\/api\/expenses\/([A-Za-z0-9]+)\/receipt\/download$/
  );
  if (req.method === 'GET' && receiptDownloadMatch)
    return sendReceiptFile(req, res, receiptDownloadMatch[1], true);
  const receiptContentMatch = pathname.match(/^\/api\/expenses\/([A-Za-z0-9]+)\/receipt\/content$/);
  if (req.method === 'GET' && receiptContentMatch)
    return sendReceiptFile(req, res, receiptContentMatch[1]);
  const receiptPreviewMatch = pathname.match(
    /^\/api\/expenses\/([A-Za-z0-9]+)\/receipt\/preview\/(\d+)$/
  );
  if (req.method === 'GET' && receiptPreviewMatch)
    return viewReceiptPreview(req, res, receiptPreviewMatch[1], receiptPreviewMatch[2]);
  const receiptViewMatch = pathname.match(/^\/api\/expenses\/([A-Za-z0-9]+)\/receipt\/view$/);
  if (req.method === 'GET' && receiptViewMatch) return viewReceipt(req, res, receiptViewMatch[1]);
  const expenseMatch = pathname.match(/^\/api\/expenses\/([A-Za-z0-9]+)$/);
  if (req.method === 'PATCH' && expenseMatch) return reviewExpense(req, res, expenseMatch[1]);
  if (req.method === 'PUT' && expenseMatch) return editExpense(req, res, expenseMatch[1]);
  if (req.method === 'DELETE' && expenseMatch) return deleteExpense(req, res, expenseMatch[1]);
  if (req.method === 'POST' && pathname === '/api/ocr') return scanReceipt(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(res, 405, { error: 'Method not allowed' });
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(publicDir, requested));
  if (file !== publicDir && !file.startsWith(`${publicDir}/`))
    return send(res, 403, { error: 'Forbidden' });
  try {
    let content = await readFile(file);
    const extension = extname(file);
    const nonce = extension === '.html' ? requestNonce() : '';
    if (nonce)
      content = Buffer.from(
        content.toString('utf8').replace(/<(script|style)(?=[\s>])/gi, `<$1 nonce="${nonce}"`)
      );
    res.writeHead(200, {
      'Content-Type': types[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...securityHeaders(nonce)
    });
    if (req.method === 'GET') res.end(content);
    else res.end();
  } catch {
    res.writeHead(404, securityHeaders());
    res.end('Not found');
  }
}
function requiresDataWriteLock(req, pathname) {
  if (!pathname.startsWith('/api/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
    return false;
  return pathname !== '/api/ocr';
}
async function route(req, res) {
  if (shuttingDown)
    return send(res, 503, { error: 'The service is restarting. Please retry shortly.' });
  const pathname = new URL(req.url, 'http://local').pathname;
  if (!requiresDataWriteLock(req, pathname)) return routeRequest(req, res);
  const work = dataWriteQueue.then(() => routeRequest(req, res));
  dataWriteQueue = work.catch(error => {
    console.error('Data write request failed', error.message);
  });
  return work;
}
let shuttingDown = false;
const server = createServer((req, res) => {
  route(req, res).catch(error => {
    console.error('Unhandled request failure', error.message);
    if (!res.headersSent) send(res, 500, { error: 'The server could not complete this request.' });
    else res.end();
  });
});
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await dataWriteQueue;
    await auditWriteQueue;
    process.exit(0);
  });
  server.closeIdleConnections?.();
});
server.requestTimeout = 65_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => console.log(`Expense app running at http://${host}:${port}`));
