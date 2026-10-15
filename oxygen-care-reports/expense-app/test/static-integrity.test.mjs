import test from 'node:test';
import assert from './source-assert.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(appDir, 'public');

test('all shipped JavaScript and inline scripts parse', async () => {
  const files = await readdir(publicDir);
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const source = await readFile(join(publicDir, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  }
  for (const file of files.filter(name => name.endsWith('.html'))) {
    const html = await readFile(join(publicDir, file), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    for (const [index, match] of scripts.entries()) {
      if (!match[1].trim()) continue;
      assert.doesNotThrow(
        () => new vm.Script(match[1], { filename: `${file}:script-${index + 1}` })
      );
    }
  }
});

test('local page assets exist and the shared API client is loaded before consumers', async () => {
  const files = await readdir(publicDir);
  const fileSet = new Set(files);
  for (const file of files.filter(name => name.endsWith('.html'))) {
    const html = await readFile(join(publicDir, file), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="\/([^"?#]+\.(?:js|css|jpeg))"/g))
      assert.ok(fileSet.has(match[1]), `${file} references missing ${match[1]}`);
    if (/oxygenApi|review-common\.js|app\.js/.test(html)) {
      const shared = html.indexOf('/http.js');
      const consumerPositions = ['/app.js', '/review-common.js', 'window.oxygenApi']
        .map(value => html.indexOf(value))
        .filter(value => value >= 0);
      assert.ok(
        shared >= 0 && consumerPositions.every(position => shared < position),
        `${file} must load http.js before API consumers`
      );
    }
  }
});

test('retired receipt routes and launchers are absent from the release', async () => {
  const files = await readdir(publicDir);
  const sources = await Promise.all(
    files
      .filter(name => /\.(?:html|js)$/.test(name))
      .map(name => readFile(join(publicDir, name), 'utf8'))
  );
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /\/receipt(?:\/image)?["'`]/);
  assert.doesNotMatch(combined, /Download receipt/);
  assert.match(combined, /\/receipt\/view/);

  const rootFiles = await readdir(appDir);
  assert.ok(!rootFiles.includes('Start Oxygen Care.command'));
  assert.ok(!rootFiles.includes('deploy-ubuntu.sh'));
  assert.ok(!rootFiles.includes('SERVER-TRANSFER.md'));
  assert.ok(rootFiles.includes('deploy-server.sh'));
});

test('deployment updater protects data and validates the live layout', async () => {
  const local = await readFile(join(appDir, 'deploy-server.sh'), 'utf8');
  const remote = await readFile(join(appDir, 'scripts', 'remote-update.sh'), 'utf8');
  assert.doesNotMatch(local, /PROJECT_DIR[^\n]*data|\/data\//);
  assert.match(local, /rsync --archive --delete .*public/);
  assert.match(remote, /--exclude='\.\/data'/);
  assert.match(remote, /WorkingDirectory/);
  assert.match(remote, /sudo -v/);
  assert.match(remote, /command -v pdfinfo/);
  assert.match(remote, /command -v pdftoppm/);
  assert.match(remote, /apt-get install -y nginx/);
  assert.match(remote, /listen 127\.0\.0\.1:8080/);
  assert.match(remote, /tailscale serve --bg --yes --https=443 http:\/\/127\.0\.0\.1:8080/);
  assert.match(remote, /expenses\.fynbos-spectrum\.ts\.net/);
  assert.doesNotMatch(
    remote,
    /tailscale serve reset/,
    'expense deployment must preserve other applications’ Serve listeners'
  );
  assert.match(remote, /trap rollback ERR/);
  assert.doesNotMatch(remote, /tar -C "\$APP_DIR\/data" -xzf/);
  assert.ok(
    remote.indexOf('sudo systemctl stop "$APP_NAME"') <
      remote.indexOf('tar -C "$APP_DIR/data" -czf')
  );
  assert.doesNotMatch(remote, /node "\$STAGE_DIR\/scripts\/maintenance-cleanup.mjs"/);
  assert.match(remote, /maintenance-cleanup\.mjs/);
  assert.match(remote, /rm -f .*Start Oxygen Care\.command.*deploy-ubuntu\.sh/);
});

test('retired integrations and unsafe default binding cannot return', async () => {
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  const environment = await readFile(join(appDir, '.env.example'), 'utf8');
  assert.doesNotMatch(`${server}\n${environment}`, /anthropic/i);
  assert.match(server, /process\.env\.HOST \|\| "127\.0\.0\.1"/);
  assert.doesNotMatch(server, /process\.env\.HOST \|\| "0\.0\.0\.0"/);
  assert.equal((server.match(/async function scanWith(?:Tesseract|Azure)/g) || []).length, 2);
});

test('saved odometer readings expose an explicit edit state', async () => {
  const app = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /Edit odometer reading/);
  assert.match(app, /Monthly odometer reading updated\./);
  assert.match(app, /editableReadings\.forEach/);
  assert.match(app, /button\('Odometer', \(\) => go\('odometer'\)\)/);
  assert.match(app, /if \(state\.view === 'odometer'\) return odometerPage\(\)/);
  assert.match(app, /function odometerPage\(\) \{ setContent\(odometerLogCard\(\)\); \}/);
  const home =
    /async function regularHome\(\)([\s\S]*?)\n  function odometerPage/.exec(app)?.[1] || '';
  assert.doesNotMatch(home, /odometerLogCard/);
});

test('odometer entry and reports retain two cars and a combined total', async () => {
  const [app, reports, server] = await Promise.all([
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'reports.html'), 'utf8'),
    readFile(join(appDir, 'server.mjs'), 'utf8')
  ]);
  for (const source of [app, reports, server]) {
    assert.match(source, /car1OpeningReading/);
    assert.match(source, /car2OpeningReading/);
  }
  assert.match(app, /COMBINED DISTANCE/);
  assert.match(reports, /Combined KM/);
  assert.match(server, /car1Kilometres \+ car2Kilometres/);
});

test('report print output forcibly excludes navigation and controls', async () => {
  const [reports, styles] = await Promise.all([
    readFile(join(publicDir, 'reports.html'), 'utf8'),
    readFile(join(publicDir, 'app.css'), 'utf8')
  ]);
  assert.match(reports, /@media print\{/);
  assert.match(reports, /\.no-print,#back,\.pager,button\{display:none!important\}/);
  assert.match(reports, /-webkit-print-color-adjust:exact!important/);
  assert.match(styles, /print-color-adjust:exact!important/);
});

test('single expense print output excludes app navigation and actions', async () => {
  const [app, styles] = await Promise.all([
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'app.css'), 'utf8')
  ]);
  assert.match(app, /classList\.add\('print-expense'\)/);
  assert.match(
    styles,
    /body\.print-expense \.workspace,body\.print-expense \.account,body\.print-expense \.actions\{display:none!important\}/
  );
});

test('CSP and server resource limits remain hardened', async () => {
  const [server, remote] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(appDir, 'scripts', 'remote-update.sh'), 'utf8')
  ]);
  assert.doesNotMatch(server, /script-src 'self'[^;]*'unsafe-inline'/);
  assert.match(server, /script-src 'self'\$\{nonceSource\}/);
  assert.match(server, /server\.requestTimeout = 65_000/);
  assert.match(server, /server\.headersTimeout = 15_000/);
  assert.match(server, /server\.maxRequestsPerSocket = 100/);
  assert.match(remote, /limit_conn_zone \$binary_remote_addr/);
  assert.match(remote, /limit_conn oxygen_expenses_connections 20/);
  assert.match(remote, /client_body_timeout 15s/);
  assert.match(remote, /client_header_timeout 15s/);
});

test('review expense rows open for Super Users and Department Heads', async () => {
  const [review, details] = await Promise.all([
    readFile(join(publicDir, 'review-common.js'), 'utf8'),
    readFile(join(publicDir, 'expense-detail.html'), 'utf8')
  ]);
  assert.match(review, /location\.href = `\/expense-detail\.html\?\$\{details\}`/);
  assert.match(review, /reviewReturn: `\$\{location\.pathname\}\$\{location\.search\}`/);
  assert.match(details, /query\.get\('reviewReturn'\)/);
  assert.match(details, /target\.pathname === expectedPath/);
  assert.match(details, /target\.searchParams\.get\('userId'\) === userId/);
  assert.doesNotMatch(review, /closest\('button,a,details,summary'\)/);
  assert.match(review, /closest\('button,a'\)/);
  assert.doesNotMatch(review, /Review history|appendHistory|reviewHistory/);
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  assert.doesNotMatch(server, /reviewHistory/);
});

test('questioned expenses are explicitly editable by their owner and resubmitted', async () => {
  const [app, server] = await Promise.all([
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(appDir, 'server.mjs'), 'utf8')
  ]);
  assert.match(app, /status === 'question' \? 'Respond \/ Edit expense'/);
  assert.match(server, /target\.userId !== user\.id/);
  assert.match(server, /reviewStatus: 'pending', reviewNote: ''/);
  assert.doesNotMatch(server, /expense_edited|status: 'edited'|Expense updated after/);
});

test('mileage expenses expose an explicit edit workflow and remain locked after approval', async () => {
  const [app, server] = await Promise.all([
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(appDir, 'server.mjs'), 'utf8')
  ]);
  assert.match(app, /Edit mileage expense/);
  assert.match(app, /Mileage expense updated and returned to Pending review\./);
  assert.match(app, /loaded\?\.reviewStatus === 'approved'/);
  assert.match(server, /existing\?\.reviewStatus === 'approved'/);
  assert.match(server, /mileageExpenseCategory = "Mileage Expense"/);
  assert.match(server, /category: mileageExpenseCategory/);
});

test('expense report rows open secured expense details and return to reports', async () => {
  const [reports, details] = await Promise.all([
    readFile(join(publicDir, 'reports.html'), 'utf8'),
    readFile(join(publicDir, 'expense-detail.html'), 'utf8')
  ]);
  assert.match(reports, /function openExpense\(event,expense\)/);
  assert.match(reports, /review:'super',returnTo:'reports'/);
  assert.match(reports, /row\.tabIndex=0/);
  assert.match(details, /returnTo === 'reports'/);
  assert.match(details, /target\.pathname === '\/reports\.html'/);
});

test('receipt images are compressed server-side with enforced upload and storage limits', async () => {
  const [server, app, localDeploy, remoteDeploy, manifest] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(appDir, 'deploy-server.sh'), 'utf8'),
    readFile(join(appDir, 'scripts', 'remote-update.sh'), 'utf8'),
    readFile(join(appDir, 'package.json'), 'utf8')
  ]);
  assert.equal(JSON.parse(manifest).dependencies.sharp, '0.35.5');
  assert.match(server, /sharp\.concurrency\(1\)/);
  assert.match(server, /\.rotate\(\)\.resize\(\{ width: 2000, height: 2000/);
  assert.match(server, /jpeg\(\{ quality: 82, mozjpeg: true \}\)/);
  assert.match(server, /receiptImageUploadMaxBytes = 10 \* 1024 \* 1024/);
  assert.match(server, /receiptImageStoredMaxBytes = 2 \* 1024 \* 1024/);
  assert.match(server, /receiptPdfMaxBytes = 4 \* 1024 \* 1024/);
  assert.match(app, /compressed securely when saved/);
  assert.match(localDeploy, /package-lock\.json/);
  assert.match(remoteDeploy, /npm ci --omit=dev/);
  assert.ok(
    remoteDeploy.indexOf('npm ci --omit=dev') <
      remoteDeploy.indexOf('node --test test/receipt-access.test.mjs'),
    'remote tests must run after production dependencies are installed'
  );
  assert.match(remoteDeploy, /client_max_body_size 15m/);
});

test('dashboard keeps its main chart without the duplicate chart builder', async () => {
  const app = await readFile(join(publicDir, 'app.js'), 'utf8');
  const css = await readFile(join(publicDir, 'app.css'), 'utf8');
  assert.doesNotMatch(app, /addPieGenerator|EXPENSE PIE CHART GENERATOR|chart-builder/);
  assert.doesNotMatch(css, /chart-builder/);
  assert.match(app, /async function superDashboard/);
  assert.match(app, /class: 'chart'/);
});

test('category creation offers an unchecked company-paid option and submits a boolean', async () => {
  const settings = await readFile(join(publicDir, 'settings.html'), 'utf8');
  assert.match(settings, /<input name="companyPaid" type="checkbox">Company paid/);
  assert.match(
    settings,
    /companyPaid: form\.querySelector\('input\[name="companyPaid"\]'\)\.checked/
  );
  assert.match(settings, /settings\.companyPaidCategories/);
});

test('Fuel Card is retained separately and excluded from expense totals', async () => {
  const [server, app, reports] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'reports.html'), 'utf8')
  ]);
  assert.match(server, /companyPaidCategory = "Fuel Card"/);
  assert.match(server, /\[companyPaidCategory, mileageExpenseCategory\]\.includes/);
  assert.match(app, /YEAR-TO-DATE EXPENSES/);
  assert.match(app, /YEAR-TO-DATE COMPANY PAID/);
  assert.match(app, /userPaid = records\.filter\(expense => !isCompanyPaid\(expense\)\)/);
  assert.match(reports, /Expenses: \$\{money\(userPaid/);
  assert.match(reports, /Company paid:/);
  assert.match(server, /companyPaid: isCompanyPaid\(value\)/);
});

test('user and Department Head year-to-date cards appear in History, not Home', async () => {
  const app = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(app, /function yearToDateCards\(\)/);
  assert.match(
    app,
    /records = state\.expenses\.filter\(expense => String\(expense\.date \|\| ''\)\.startsWith\(year\)\)/
  );
  assert.match(
    app,
    /async function expenseHistory\(\)[\s\S]*?setContent\(\.\.\.yearToDateCards\(\), card/
  );
  assert.match(app, /function renderFlatExpenseList\(records\)/);
  const history =
    /async function expenseHistory\(\)([\s\S]*?)\n  async function reimbursementHistory/.exec(
      app
    )?.[1] || '';
  assert.match(history, /renderFlatExpenseList\(records\)/);
  assert.doesNotMatch(history, /renderExpenseList\(records\)/);
  const home =
    /async function regularHome\(\)([\s\S]*?)\n  async function expenseHistory/.exec(app)?.[1] ||
    '';
  assert.doesNotMatch(home, /yearToDateCards|YEAR-TO-DATE|hero|fuelCardTotal/);
});

test('expense views use an accessible year, month, and day calendar drill-down', async () => {
  const [app, index, styles, calendar, review, headReview] = await Promise.all([
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'index.html'), 'utf8'),
    readFile(join(publicDir, 'calendar.css'), 'utf8'),
    readFile(join(publicDir, 'expense-calendar.js'), 'utf8'),
    readFile(join(publicDir, 'review.html'), 'utf8'),
    readFile(join(publicDir, 'review-head.html'), 'utf8')
  ]);
  assert.match(index, /href="\/calendar\.css"/);
  assert.match(app, /class: 'expense-stack'/);
  assert.match(app, /history\.pushState\(\{ calendar: true \}/);
  assert.match(app, /class: 'calendar-grid year-grid'/);
  assert.match(app, /class: 'calendar-grid month-grid'/);
  assert.match(app, /class: 'calendar-grid day-grid'/);
  assert.match(app, /button\('‹ Back', parentLevel/);
  assert.doesNotMatch(app, /history\.back\(\)/);
  assert.match(app, /category\.onchange = \(\) => resetExpenseCalendar\(draw, \{ category:/);
  assert.match(app, /restoreFilter\(category, 'category'\)/);
  assert.match(app, /restoreFilter\(from, 'from'\)/);
  assert.match(
    app,
    /\[from, to, category\]\.forEach\(input => \(?input\.onchange = \(\) => resetExpenseCalendar\(draw, \{ from:/
  );
  assert.match(app, /weekday: 'short', day: 'numeric'/);
  assert.match(styles, /\.calendar-cell/);
  assert.match(styles, /@media\(max-width:520px\)/);
  assert.match(calendar, /window\.OxygenExpenseCalendar = \{ render, reset \}/);
  assert.match(calendar, /history\.pushState\(\{ calendar: true \}/);
  assert.match(calendar, /back\.onclick = \(\) => parentLevel\(redraw\)/);
  assert.doesNotMatch(calendar, /back\.onclick = \(\) => history\.back\(\)/);
  assert.match(review, /src="\/expense-calendar\.js"/);
  assert.match(headReview, /src="\/expense-calendar\.js"/);
});

test('receipt and expense navigation cannot loop through browser history', async () => {
  const [server, app, review, details, reports] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'review-common.js'), 'utf8'),
    readFile(join(publicDir, 'expense-detail.html'), 'utf8'),
    readFile(join(publicDir, 'reports.html'), 'utf8')
  ]);
  assert.match(server, /location\.replace\(event\.currentTarget\.href\)/);
  assert.equal((server.match(/function receiptViewerPage\(/g) || []).length, 1);
  assert.equal(
    (server.match(/document\.getElementById\('save'\)\.addEventListener/g) || []).length,
    1
  );
  assert.doesNotMatch(
    `${app}\n${review}\n${details}\n${reports}`,
    /target\s*=\s*['"]_blank['"]|target:\s*['_"]blank/
  );
  assert.doesNotMatch(`${review}\n${details}`, /opened|window\.close/);
  assert.doesNotMatch(app, /history\.state\s*\?\s*history\.back/);
  assert.match(app, /button\('Back', \(\) => go\(state\.returnTo === 'history'/);
});

test('Super User reports remain a printable filter-driven list', async () => {
  const reports = await readFile(join(publicDir, 'reports.html'), 'utf8');
  assert.doesNotMatch(
    reports,
    /expense-calendar\.js|OxygenExpenseCalendar|drawReportCalendar|reportCalendarRoot/
  );
  assert.match(
    reports,
    /for\(const id of \['from','to','dept','user','category'\]\)\$\('#'\+id\)\.onchange=\(\)=>draw\(true\)/
  );
  assert.match(reports, /const rows=selected\(\)\.sort/);
  assert.match(reports, /pageRows\('#expenseReport','expenses',rows,draw\)/);
  assert.match(
    reports,
    /new Option\('Current page','page'\),new Option\('All filtered results','all'\)/
  );
  assert.match(reports, /if\(printRange\.value==='all'\)\$\('#rows'\)\.replaceChildren/);
  assert.match(reports, /addEventListener\('afterprint',restore,\{once:true\}\)/);
});

test('department review uses same-screen navigation and never renders null placeholders', async () => {
  const app = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function openReview\(path\) \{ location\.assign\(new URL\(path, location\.origin\)\.href\); \}/
  );
  assert.doesNotMatch(app, /Allow pop-ups to open the expense review/);
  assert.match(app, /replaceChildren\(\.\.\.children\.filter\(Boolean\)\)/);
});

test('successful login and logout discard stale expense routes', async () => {
  const app = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(
    app,
    /function resetWorkspaceRoute\(\) \{ history\.replaceState\(\{ view: 'home' \}, '', '\/'\)/
  );
  assert.match(
    app,
    /resetWorkspaceRoute\(\); await start\(result\.user, result\.idleTimeoutMinutes\)/
  );
  assert.match(app, /clearTimeout\(idleTimer\); location\.assign\('\/logout'\)/);
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  assert.match(server, /req\.method === "GET" && pathname === "\/logout"/);
  assert.match(server, /res\.writeHead\(303, \{ "Location": "\/"/);
});

test('editable text limits match in the browser and server', async () => {
  const [server, app, index, settings, review] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'index.html'), 'utf8'),
    readFile(join(publicDir, 'settings.html'), 'utf8'),
    readFile(join(publicDir, 'review-common.js'), 'utf8')
  ]);
  assert.match(
    server,
    /fullName: 100, email: 254, jobDescription: 120, carRegistration: 20, department: 80, category: 60, merchant: 120, note: 300, message: 300, password: 128/
  );
  assert.match(server, /cleanField\(fullName, textLimits\.fullName\)/);
  assert.match(server, /validEmail\(normalised\)/);
  assert.match(app, /maxlength: '100'/);
  assert.match(app, /maxlength: '254'/);
  assert.match(app, /maxlength: '120'/);
  assert.match(app, /maxlength: '20'/);
  assert.match(index, /id="loginEmail"[^>]*maxlength="254"/);
  assert.match(index, /id="loginPassword"[^>]*maxlength="128"/);
  assert.match(settings, /maxlength="80"[^>]*placeholder="e\.g\. Customer Care"/);
  assert.match(settings, /maxlength="60"[^>]*placeholder="e\.g\. Training"/);
  assert.match(review, /input\.maxLength = 300/);
});

test('possible duplicates warn but can be explicitly saved', async () => {
  const [server, app, http] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'http.js'), 'utf8')
  ]);
  assert.match(server, /duplicate && input\.confirmDuplicate !== true/);
  assert.match(server, /code: 'possible_duplicate'/);
  assert.doesNotMatch(server, /duplicate_expense_blocked|Possible duplicate blocked/);
  assert.match(app, /error\.code !== 'possible_duplicate' \|\| submission.confirmDuplicate/);
  assert.match(app, /submission.confirmDuplicate = true/);
  assert.match(http, /error\.code = data\.code \|\| ''/);
});

test('local OCR uses adaptive preprocessing without changing stored receipts', async () => {
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  assert.match(server, /\.grayscale\(\)\.normalize\(\)\.sharpen\(\{ sigma: 1 \}\)/);
  assert.match(server, /\.linear\(1\.2, -18\)\.threshold\(180\)/);
  assert.match(server, /tesseractText\(primaryImage, "6"\)/);
  assert.match(server, /tesseractResultScore\(primary\) < 5/);
  assert.match(server, /tesseractText\(retryImage, "4"\)/);
  assert.match(
    server,
    /if \(tesseractResultScore\(retry\) > tesseractResultScore\(primary\)\) best = retry/
  );
  assert.match(server, /const bytes = receipt\.bytes;\n    const preparedImage/);
});

test('Department Heads and Super Users batch approve within their role boundaries', async () => {
  const [server, app, page, details] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'batch-approve.html'), 'utf8'),
    readFile(join(publicDir, 'expense-detail.html'), 'utf8')
  ]);
  assert.match(
    app,
    /state\.user\.role === 'department_head'\) workspace\.append\(element\('a', \{ class: 'link-button', href: '\/batch-approve\.html', text: 'Batch' \}\)\)/
  );
  assert.match(app, /href: '\/batch-approve\.html', text: 'Batch'/);
  const reviewPanel =
    /async function addDepartmentReview\(\)([\s\S]*?)\n  async function render/.exec(app)?.[1] ||
    '';
  assert.doesNotMatch(reviewPanel, /Batch|batch-approve/);
  assert.match(server, /!\['super', 'department_head'\]\.includes\(reviewer\.role\)/);
  assert.match(server, /ids\.length > 100/);
  assert.match(
    server,
    /reviewer\.role === 'super' \? owner && \['regular', 'department_head'\]\.includes\(owner\.role\)/
  );
  assert.match(server, /\(expense\.reviewStatus \|\| 'pending'\) !== 'pending'/);
  assert.match(
    server,
    /One or more selected expenses are no longer pending or available to you\. Nothing was approved\./
  );
  assert.match(server, /expenses_batch_approved/);
  assert.match(server, /pathname === "\/api\/expenses\/batch-approve"/);
  assert.match(page, /Select all filtered pending expenses/);
  assert.match(page, /\/api\/expenses\/batch-approve/);
  assert.match(page, /confirm\(`Approve \$\{ids\.length\} selected expense/);
  assert.match(page, /me\.user\.role==='super'/);
  assert.match(page, /api\('\/api\/reports\/expenses'\)/);
  assert.match(page, /const filterIds=\['from','to','user','category'\]/);
  assert.match(
    page,
    /history\.replaceState\(history\.state,'',`\$\{url\.pathname\}\$\{url\.search\}`\)/
  );
  assert.match(page, /function restoreFilters\(\)/);
  assert.match(page, /returnTo=`\$\{location\.pathname\}\$\{location\.search\}`/);
  assert.match(
    page,
    /returnTo:'batch',batchReturn:`\$\{location\.pathname\}\$\{location\.search\}`/
  );
  assert.match(page, /closest\('input,a,button'\)/);
  assert.match(page, /row\.onkeydown=event/);
  assert.match(details, /returnTo === 'batch'/);
  assert.match(details, /target\.pathname === '\/batch-approve\.html'/);
  assert.match(
    details,
    /report\.expenses\.find\(item => item\.id === expenseId && item\.user\.id === userId\)/
  );
});

test('Super Users create reimbursement batches from approved unpaid expenses', async () => {
  const [server, app, reports] = await Promise.all([
    readFile(join(appDir, 'server.mjs'), 'utf8'),
    readFile(join(publicDir, 'app.js'), 'utf8'),
    readFile(join(publicDir, 'reports.html'), 'utf8')
  ]);
  assert.match(server, /async function reimbursementCandidates/);
  assert.match(
    server,
    /expense\.reviewStatus === 'approved' && !expense\.reimbursementId && !isCompanyPaid\(expense\)/
  );
  assert.match(server, /async function createReimbursementBatch/);
  assert.match(server, /One or more selected expenses are no longer eligible\. Nothing was sent\./);
  assert.match(server, /reimbursement_batch_sent/);
  assert.match(server, /reimbursementPaymentDate: paymentDate/);
  assert.match(server, /\/reimbursement-candidates\$\/\)/);
  assert.match(server, /\/reimbursements\$\/\)/);
  assert.doesNotMatch(app, /reimbursementPage|Create reimbursement/);
  assert.match(reports, /async function reimbursementPage\(person\)/);
  assert.match(reports, /id="reimbursementComposer" class="no-print"/);
  assert.match(reports, /if \(reportTab !== 'reimbursements'\) return/);
  assert.match(reports, /Select approved expenses that are included in this payment/);
  assert.match(reports, /MESSAGE PREVIEW/);
  assert.match(reports, /Send reimbursement/);
  assert.match(reports, /Back to reimbursements/);
  assert.doesNotMatch(app, /Send reimbursement notice', async \(\) => \{ const message = prompt/);
  assert.match(reports, /Payment date/);
  assert.match(reports, /Expense IDs/);
});
