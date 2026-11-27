import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Run } from './types.js';

function checkId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid session or run ID');
}

function outsideWorkspace(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
    throw new Error('State directory must be outside the editable workspace');
  }
}

function prospectivePath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return join(prospectivePath(parent), relative(parent, path));
}

function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Atomically publishes a fully written owner record. A process crash leaves a reclaimable lock. */
async function exclusively<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const candidate = `${path}.${randomUUID()}`;
  writeFileSync(candidate, String(process.pid), { mode: 0o600, flag: 'wx' });
  try {
    try {
      linkSync(candidate, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner < 1 || processAlive(owner)) {
        throw new Error('Another process is using this workspace');
      }
      // Reclaim operations are serialized by a second exclusive lock.
      return await reclaim(path, owner, candidate, operation);
    }
    try {
      return await operation();
    } finally {
      unlinkSync(path);
    }
  } finally {
    unlinkSync(candidate);
  }
}

async function reclaim<T>(
  path: string,
  owner: number,
  candidate: string,
  operation: () => Promise<T>,
): Promise<T> {
  const gate = `${path}.reclaim`;
  try {
    linkSync(candidate, gate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A crash during reclaim is recoverable without requiring manual lock deletion.
    const reclaimer = Number(readFileSync(gate, 'utf8'));
    if (Number.isSafeInteger(reclaimer) && reclaimer > 0 && !processAlive(reclaimer)) {
      unlinkSync(gate);
    }
    throw new Error('Workspace lock recovery is in progress. Try again.');
  }
  try {
    if (!existsSync(path) || Number(readFileSync(path, 'utf8')) !== owner || processAlive(owner)) {
      throw new Error('Workspace lock changed during recovery. Try again.');
    }
    unlinkSync(path);
    linkSync(candidate, path);
  } finally {
    unlinkSync(gate);
  }
  try {
    return await operation();
  } finally {
    unlinkSync(path);
  }
}

export class RunStore {
  readonly directory: string;
  private readonly runsDir: string;
  private readonly eventsDir: string;
  private readonly lock: string;

  constructor(path: string, workspace: string) {
    const safePath = prospectivePath(resolve(path));
    outsideWorkspace(safePath, workspace);
    this.directory = safePath;
    this.runsDir = join(safePath, 'runs');
    this.eventsDir = join(safePath, 'events');
    for (const directory of [safePath, this.runsDir, this.eventsDir]) {
      mkdirSync(directory, { mode: 0o700, recursive: true });
      outsideWorkspace(realpathSync(directory), workspace);
    }
    // One lock per project even when two CLI instances choose different state directories.
    const lockDir = join(tmpdir(), `workbench-agent-${process.getuid?.() ?? 'user'}`);
    mkdirSync(lockDir, { mode: 0o700, recursive: true });
    this.lock = join(lockDir, createHash('sha256').update(workspace).digest('hex'));
  }

  save(run: Run): void {
    atomicWrite(this.runPath(run.id), JSON.stringify(run));
    this.exportEvents(run);
  }

  get(id: string): Run {
    return JSON.parse(readFileSync(this.runPath(id), 'utf8')) as Run;
  }

  exportEvents(run: Run): void {
    checkId(run.id);
    const lines = run.events.map((event) => JSON.stringify(event));
    atomicWrite(
      join(this.eventsDir, `${run.id}.jsonl`),
      lines.length ? `${lines.join('\n')}\n` : '',
    );
  }

  session(id: string): Run[] {
    checkId(id);
    return readdirSync(this.runsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.get(file.slice(0, -5)))
      .filter((run) => run.sessionId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  lockWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    return exclusively(this.lock, operation);
  }

  private runPath(id: string): string {
    checkId(id);
    return join(this.runsDir, `${id}.json`);
  }
}
