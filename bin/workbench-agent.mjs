#!/usr/bin/env node
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const cli = new URL('../dist/src/cli/index.js', import.meta.url);
if (existsSync(cli)) {
  await import(cli.href);
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  process.stderr.write(`Workbench Agent ещё не собран. Выполните npm run build в ${root}\n`);
  process.exitCode = 1;
}
