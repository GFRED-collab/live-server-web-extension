import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

let loads = 0;
// RAPIDOCR_PYTHON and PADDLEOCR_PYTHON are read when the code loads, so each call loads a fresh copy.
async function loadOcrRunners() {
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  const start = server.indexOf('function startHelper(');
  const end = server.indexOf('async function localOcrVariants(');
  assert.ok(start >= 0 && end > start);
  const source = `// load ${(loads += 1)}\nimport { spawn } from "node:child_process";\nimport { join } from "node:path";\nconst upstreamTimeoutMs = 5000;\n${server.slice(start, end)}\nexport { tesseractText, rapidOcrText, paddleOcrText };`;
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}
const loadTesseractText = async () => (await loadOcrRunners()).tesseractText;

test('RapidOCR failover runs the helper script with the configured Python', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'fake-rapidocr-'));
  const originalPython = process.env.RAPIDOCR_PYTHON;
  try {
    // Stands in for Python: checks it was given the helper script, then prints receipt text.
    await writeFile(
      join(bin, 'python3'),
      '#!/bin/sh\ncase "$2" in */scripts/rapidocr_text.py) cat >/dev/null; printf "SHOP LTD\\nTOTAL 9.99\\n";; *) exit 3;; esac\n'
    );
    await chmod(join(bin, 'python3'), 0o755);
    process.env.RAPIDOCR_PYTHON = join(bin, 'python3');
    const { rapidOcrText } = await loadOcrRunners();
    assert.equal(await rapidOcrText(Buffer.from('image')), 'SHOP LTD\nTOTAL 9.99\n');

    process.env.RAPIDOCR_PYTHON = join(bin, 'missing-python3');
    const missing = (await loadOcrRunners()).rapidOcrText;
    await assert.rejects(missing(Buffer.from('image')), /RapidOCR is not installed on this server/);
  } finally {
    if (originalPython === undefined) delete process.env.RAPIDOCR_PYTHON;
    else process.env.RAPIDOCR_PYTHON = originalPython;
    await rm(bin, { recursive: true, force: true });
  }
});

test('PaddleOCR fallback runs its helper script with the configured Python', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'fake-paddleocr-'));
  const originalPython = process.env.PADDLEOCR_PYTHON;
  try {
    await writeFile(
      join(bin, 'python3'),
      '#!/bin/sh\ncase "$2" in */scripts/paddleocr_text.py) cat >/dev/null; printf "CAFE\\nTOTAL 4.50\\n";; *) exit 3;; esac\n'
    );
    await chmod(join(bin, 'python3'), 0o755);
    process.env.PADDLEOCR_PYTHON = join(bin, 'python3');
    const { paddleOcrText } = await loadOcrRunners();
    assert.equal(await paddleOcrText(Buffer.from('image')), 'CAFE\nTOTAL 4.50\n');

    process.env.PADDLEOCR_PYTHON = join(bin, 'missing-python3');
    const missing = (await loadOcrRunners()).paddleOcrText;
    await assert.rejects(
      missing(Buffer.from('image')),
      /PaddleOCR is not installed on this server/
    );
  } finally {
    if (originalPython === undefined) delete process.env.PADDLEOCR_PYTHON;
    else process.env.PADDLEOCR_PYTHON = originalPython;
    await rm(bin, { recursive: true, force: true });
  }
});

test('a slow OCR program is stopped at the shared scan deadline', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'slow-ocr-'));
  const originalPython = process.env.RAPIDOCR_PYTHON;
  try {
    await writeFile(join(bin, 'python3'), '#!/bin/sh\ncat >/dev/null\nsleep 10\n');
    await chmod(join(bin, 'python3'), 0o755);
    process.env.RAPIDOCR_PYTHON = join(bin, 'python3');
    const { rapidOcrText } = await loadOcrRunners();
    const started = Date.now();
    await assert.rejects(
      rapidOcrText(Buffer.from('image'), Date.now() + 1500),
      /RapidOCR timed out/
    );
    assert.ok(Date.now() - started < 4000);
  } finally {
    if (originalPython === undefined) delete process.env.RAPIDOCR_PYTHON;
    else process.env.RAPIDOCR_PYTHON = originalPython;
    await rm(bin, { recursive: true, force: true });
  }
});

test('Tesseract exiting before reading the receipt rejects instead of crashing the server', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'fake-tesseract-'));
  const originalPath = process.env.PATH;
  try {
    await writeFile(join(bin, 'tesseract'), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, 'tesseract'), 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
    const tesseractText = await loadTesseractText();
    await assert.rejects(tesseractText(Buffer.alloc(5_000_000)), /could not read this receipt/);
  } finally {
    process.env.PATH = originalPath;
    await rm(bin, { recursive: true, force: true });
  }
});

async function loadReceiptParser() {
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  const start = server.indexOf('function amountFromText(');
  const end = server.indexOf('// Runs a local OCR program');
  assert.ok(start >= 0 && end > start);
  const source = `${server.slice(start, end)}\nexport { parseTesseractReceipt };`;
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).parseTesseractReceipt;
}

test('receipt totals are found in the layouts Tesseract commonly produces', async () => {
  const parse = await loadReceiptParser();
  const cases = [
    ['SHOP LTD\nTOTAL €10.53', 10.53],
    ['SHOP LTD\nTotal EUR 6,75', 6.75],
    ['SHOP LTD\nTOTAL DUE €1, 245.00', 1245],
    ['SHOP LTD\nAMOUNT DUE 1.245,00', 1245],
    ['SHOP LTD\nTOTAL €12', 12],
    ['SHOP LTD\nTOTAL\n€ 17.49', 17.49],
    ['SHOP LTD\nTOTAL:\n17°49', 17.49],
    ['SHOP LTD\nTotal 6 ,75', 6.75],
    ['SHOP LTD\nTotal items: 3\nTOTAL 23.40', 23.4],
    ['SHOP LTD\nSUBTOTAL 20.00\nTOTAL VAT 3.40\nTOTAL SAVINGS 1.00\nTOTAL 23.40', 23.4],
    ['SHOP LTD\n14.10.2026\nMilk 2.19\nBread 1.85', 2.19],
    // RapidOCR sometimes drops the space between a word and the amount.
    ['SHOP LTD\nSUBTOTAL10.53\nTOTAL10.53', 10.53]
  ];
  for (const [text, amount] of cases) assert.equal(parse(text).amount, amount, text);
});

test('dates are read when OCR runs the year into the time', async () => {
  const parse = await loadReceiptParser();
  assert.equal(parse('SHOP LTD\nDate:14/10/202612:41\nTOTAL 1.00').date, '2026-10-14');
  assert.equal(parse('SHOP LTD\n14/10/2026 12:41\nTOTAL 1.00').date, '2026-10-14');
});

test('a total below an item price is flagged so the second OCR pass runs', async () => {
  const parse = await loadReceiptParser();
  assert.equal(parse('SHOP LTD\nPaper 12.99\nTOTAL 7.49').totalBelowItem, true);
  assert.equal(parse('SHOP LTD\nPaper 12.99\nTOTAL 17.49').totalBelowItem, false);
});

test('a timed-out OCR program is stopped together with the processes it started', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'fake-ocr-tree-'));
  const marker = join(bin, 'worker.pid');
  const originalPython = process.env.RAPIDOCR_PYTHON;
  try {
    // Starts a long-running worker (like an OCR engine's helper), records its PID and waits.
    await writeFile(join(bin, 'python3'), `#!/bin/sh\nsleep 300 &\necho $! > "${marker}"\nwait\n`);
    await chmod(join(bin, 'python3'), 0o755);
    process.env.RAPIDOCR_PYTHON = join(bin, 'python3');
    const { rapidOcrText } = await loadOcrRunners();
    await assert.rejects(rapidOcrText(Buffer.from('image'), Date.now() + 1000), /timed out/);
    const worker = Number((await readFile(marker, 'utf8')).trim());
    await new Promise(resolve => setTimeout(resolve, 200));
    // Gone, or (where nothing reaps it, as in some containers) dead and only awaiting cleanup.
    const running = await readFile(`/proc/${worker}/stat`, 'utf8').then(
      stat => !/^\d+ \(.*\) Z/.test(stat),
      () => {
        try {
          process.kill(worker, 0);
          return process.platform !== 'linux';
        } catch {
          return false;
        }
      }
    );
    assert.equal(running, false, 'the worker process was left running');
  } finally {
    if (originalPython === undefined) delete process.env.RAPIDOCR_PYTHON;
    else process.env.RAPIDOCR_PYTHON = originalPython;
    await rm(bin, { recursive: true, force: true });
  }
});
