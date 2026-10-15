import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [appArgument, quarantineArgument] = process.argv.slice(2);
if (!appArgument || !quarantineArgument) {
  throw new Error('Usage: node maintenance-cleanup.mjs APP_DIR QUARANTINE_DIR');
}

const appDir = resolve(appArgument);
const dataDir = join(appDir, 'data');
const receiptsDir = join(dataDir, 'receipts');
const expensesFile = join(dataDir, 'expenses.json');
const quarantineDir = resolve(quarantineArgument);
const receiptName = /^[a-f0-9]{32}\.(?:jpg|png|webp|pdf)$/;

const parsed = JSON.parse(await readFile(expensesFile, 'utf8'));
if (!Array.isArray(parsed)) throw new Error('expenses.json must contain an array.');

let historiesRemoved = 0;
for (const expense of parsed) {
  if (!expense || typeof expense !== 'object' || Array.isArray(expense))
    throw new Error('expenses.json contains an invalid expense.');
  if (Object.hasOwn(expense, 'reviewHistory')) {
    delete expense.reviewHistory;
    historiesRemoved += 1;
  }
}

if (historiesRemoved) {
  const temporary = `${expensesFile}.maintenance.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  JSON.parse(await readFile(temporary, 'utf8'));
  await rename(temporary, expensesFile);
  await chmod(expensesFile, 0o600);
}

const referenced = new Set(
  parsed.map(expense => expense.receiptFile).filter(value => typeof value === 'string')
);
const stored = await readdir(receiptsDir, { withFileTypes: true });
const orphaned = stored.filter(
  entry => entry.isFile() && receiptName.test(entry.name) && !referenced.has(entry.name)
);

if (orphaned.length) {
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  await chmod(quarantineDir, 0o700);
  for (const entry of orphaned) {
    const destination = join(quarantineDir, basename(entry.name));
    await rename(join(receiptsDir, entry.name), destination);
    await chmod(destination, 0o600);
  }
}

console.log(JSON.stringify({ historiesRemoved, receiptsQuarantined: orphaned.length }));
