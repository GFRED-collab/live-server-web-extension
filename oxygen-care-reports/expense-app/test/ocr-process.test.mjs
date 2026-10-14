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
