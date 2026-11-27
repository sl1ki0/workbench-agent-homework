import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function checkDirectory(path: string): string {
  if (!lstatSync(path).isDirectory()) throw new Error('Market directory must not be a symlink');
  return path;
}

export function syncPath(path: string): void {
  const file = openSync(path, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

export function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    syncPath(temporary);
    renameSync(temporary, path);
    syncPath(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readOwner(path: string): number {
  return Number(readFileSync(path, 'utf8'));
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function publishLock(candidate: string, lock: string): void {
  try {
    linkSync(candidate, lock);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const owner = readOwner(lock);
  if (isAlive(owner)) throw new Error('Another process is changing the marketplace');
  const recovery = `${lock}.recovery`;
  try {
    linkSync(candidate, recovery);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!isAlive(readOwner(recovery))) unlinkSync(recovery);
    throw new Error('Marketplace lock recovery is in progress. Try again');
  }
  try {
    if (readOwner(lock) !== owner || isAlive(owner))
      throw new Error('Marketplace lock has changed');
    unlinkSync(lock);
    linkSync(candidate, lock);
  } finally {
    unlinkSync(recovery);
  }
}

export function withLock<T>(lock: string, work: () => T): T {
  const candidate = `${lock}.${randomUUID()}`;
  writeFileSync(candidate, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    publishLock(candidate, lock);
    try {
      return work();
    } finally {
      unlinkSync(lock);
    }
  } finally {
    unlinkSync(candidate);
  }
}
