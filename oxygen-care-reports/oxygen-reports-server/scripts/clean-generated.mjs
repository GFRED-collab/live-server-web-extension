import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const generatedDirectory = resolve(process.cwd(), '.next');
await rm(generatedDirectory, { recursive: true, force: true });
console.log('Removed generated Next.js output.');
