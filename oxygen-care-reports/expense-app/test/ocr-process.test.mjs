import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadTesseractText() {
  const server = await readFile(join(appDir, 'server.mjs'), 'utf8');
  const start = server.indexOf('async function tesseractText(');
  const end = server.indexOf('async function localOcrVariants(');
  assert.ok(start >= 0 && end > start);
  const source = `import { spawn } from "node:child_process";\nconst upstreamTimeoutMs = 5000;\n${server.slice(start, end)}\nexport { tesseractText };`;
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).tesseractText;
}

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
  const end = server.indexOf('async function tesseractText(');
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
    ['SHOP LTD\n14.10.2026\nMilk 2.19\nBread 1.85', 2.19]
  ];
  for (const [text, amount] of cases) assert.equal(parse(text).amount, amount, text);
});

test('a total below an item price is flagged so the second OCR pass runs', async () => {
  const parse = await loadReceiptParser();
  assert.equal(parse('SHOP LTD\nPaper 12.99\nTOTAL 7.49').totalBelowItem, true);
  assert.equal(parse('SHOP LTD\nPaper 12.99\nTOTAL 17.49').totalBelowItem, false);
});
