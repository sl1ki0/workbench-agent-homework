import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolDefinition } from '../types.js';
import { commandTokens, contains, relativePath, type Policy } from './policy.js';
import { workspaceTools } from './tools.js';

export { readPolicy, type Policy } from './policy.js';

export interface FileState {
  hash: string;
  content: string;
  mode: number;
}

export type Snapshot = Record<string, FileState>;

export interface FileChange {
  path: string;
  before: FileState | null;
  after: FileState | null;
}

function sameState(left: FileState | null, right: FileState | null): boolean {
  return left?.hash === right?.hash && left?.mode === right?.mode;
}

export function changes(before: Snapshot, after: Snapshot): FileChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const result: FileChange[] = [];
  for (const path of paths) {
    const oldState = Object.hasOwn(before, path) ? (before[path] ?? null) : null;
    const newState = Object.hasOwn(after, path) ? (after[path] ?? null) : null;
    if (!sameState(oldState, newState)) result.push({ path, before: oldState, after: newState });
  }
  return result;
}

function assertNormalFile(file: Stats, path: string): void {
  if (!file.isFile() || file.nlink !== 1)
    throw new Error(`Expected a regular, singly-linked file: ${path}`);
}

function withFile<T>(path: string, read: (descriptor: number, mode: number) => T): T {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const file = fstatSync(descriptor);
    assertNormalFile(file, path);
    return read(descriptor, file.mode & 0o777);
  } finally {
    closeSync(descriptor);
  }
}

function fileState(path: string): FileState {
  return withFile(path, (descriptor, mode) => {
    const contents = readFileSync(descriptor);
    return {
      hash: createHash('sha256').update(contents).digest('hex'),
      content: contents.toString('base64'),
      mode,
    };
  });
}

function replaceFile(path: string, content: Buffer, mode: number): void {
  const temporary = join(dirname(path), `.agent-write-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', mode);
  try {
    try {
      writeFileSync(descriptor, content);
      fchmodSync(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

function comparable(path: string): string {
  return path.normalize('NFD').toLowerCase();
}

export class Workspace {
  readonly root: string;
  readonly policy: Policy;

  constructor(root: string, policy: Policy) {
    this.root = realpathSync(root);
    if (!lstatSync(this.root).isDirectory()) throw new Error('Workspace must be a directory');
    this.policy = structuredClone(policy);
    for (const path of [
      ...policy.directories.allow,
      ...policy.directories.deny,
      ...(policy.files?.readOnly ?? []),
    ]) {
      relativePath(path);
    }
  }

  tools(): ToolDefinition[] {
    return workspaceTools(this);
  }

  private denied(path: string): boolean {
    return this.policy.directories.deny.some((directory) =>
      contains(comparable(directory), comparable(path)),
    );
  }

  private allowed(path: string): boolean {
    return (
      !this.denied(path) &&
      this.policy.directories.allow.some((directory) => contains(directory, path))
    );
  }

  private readOnly(path: string): boolean {
    return (
      this.policy.files?.readOnly.some((entry) => contains(comparable(entry), comparable(path))) ??
      false
    );
  }

  private assertRoot(): void {
    if (realpathSync(this.root) !== this.root || !lstatSync(this.root).isDirectory()) {
      throw new Error('Workspace root has changed');
    }
  }

  private location(
    relative: string,
    allowMissing = false,
  ): { path: string; stat: Stats | undefined } {
    relativePath(relative);
    this.assertRoot();
    let path = this.root;
    let stat: Stats | undefined = lstatSync(path);
    const components = relative === '.' ? [] : relative.split('/');
    for (const [index, component] of components.entries()) {
      if (!stat?.isDirectory())
        throw new Error(`Expected an existing directory: ${dirname(relative)}`);
      const parent = path;
      path = join(parent, component);
      stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${relative}`);
      if (stat && !readdirSync(parent).includes(component))
        throw new Error(`Use the canonical spelling of ${relative}`);
      if (!stat && (!allowMissing || index !== components.length - 1)) {
        throw new Error(`Workspace path does not exist: ${relative}`);
      }
    }
    return { path, stat };
  }

  directory(relative: string): string {
    relativePath(relative);
    if (!this.allowed(relative))
      throw new Error(`Workspace directory denied by policy: ${relative}`);
    const target = this.location(relative);
    if (!target.stat?.isDirectory()) throw new Error(`Expected a directory: ${relative}`);
    return target.path;
  }

  file(relative: string, mode: 'read' | 'write'): { path: string; stat: Stats | undefined } {
    relativePath(relative);
    if (relative === '.' || !this.allowed(dirname(relative)) || this.denied(relative)) {
      throw new Error(`Workspace file denied by policy: ${relative}`);
    }
    if (mode === 'write' && this.readOnly(relative)) {
      throw new Error(`Workspace file is read-only: ${relative}`);
    }
    const target = this.location(relative, mode === 'write');
    if (target.stat) assertNormalFile(target.stat, relative);
    return target;
  }

  bash(command: string, cwd: string): { cwd: string; tokens: string[] } {
    const tokens = commandTokens(command, this.policy);
    const directory = this.directory(cwd);
    for (const token of tokens.slice(1)) {
      const argument = cwd === '.' ? token : `${cwd}/${token}`;
      if (this.denied(argument)) throw new Error(`Bash argument denied by policy: ${argument}`);
      if (this.readOnly(argument)) throw new Error(`Bash argument is read-only: ${argument}`);
      if (lstatSync(join(directory, token), { throwIfNoEntry: false })) {
        const { stat } = this.location(argument);
        if (stat && !stat.isDirectory()) assertNormalFile(stat, argument);
      }
    }
    return { cwd: directory, tokens };
  }

  *paths(relative: string): Generator<string> {
    if (
      this.denied(relative) ||
      !this.policy.directories.allow.some(
        (directory) => contains(directory, relative) || contains(relative, directory),
      )
    ) {
      return;
    }
    const { path } = this.location(relative);
    for (const name of readdirSync(path).sort()) {
      const entry = relative === '.' ? name : `${relative}/${name}`;
      if (this.denied(entry)) continue;
      const authorized = this.allowed(relative);
      const canDescend = this.policy.directories.allow.some((directory) =>
        contains(entry, directory),
      );
      if (!authorized && !canDescend) continue;
      const location = this.location(entry);
      if (location.stat?.isDirectory()) {
        yield* this.paths(entry);
      } else if (authorized) {
        if (location.stat) assertNormalFile(location.stat, entry);
        yield entry;
      }
    }
  }

  read(relative: string, maxBytes: number): { content: string; truncated: boolean } {
    const target = this.file(relative, 'read');
    return withFile(target.path, (descriptor) => {
      const chunks: Buffer[] = [];
      let remaining = maxBytes;
      while (remaining > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
        const length = readSync(descriptor, buffer);
        if (length === 0)
          return { content: Buffer.concat(chunks).toString('utf8'), truncated: false };
        chunks.push(buffer.subarray(0, length));
        remaining -= length;
      }
      const truncated = readSync(descriptor, Buffer.allocUnsafe(1)) > 0;
      return { content: Buffer.concat(chunks).toString('utf8'), truncated };
    });
  }

  write(relative: string, content: string): void {
    const { path, stat } = this.file(relative, 'write');
    replaceFile(path, Buffer.from(content, 'utf8'), stat ? stat.mode & 0o777 : 0o644);
  }

  delete(relative: string): boolean {
    const { path, stat } = this.file(relative, 'write');
    if (stat) unlinkSync(path);
    return Boolean(stat);
  }

  snapshot(): Snapshot {
    const tree: Snapshot = Object.create(null) as Snapshot;
    for (const relative of this.paths('.'))
      tree[relative] = fileState(this.file(relative, 'read').path);
    return tree;
  }

  rollback(entries: FileChange[]): void {
    const prepared = entries.map((entry) => {
      const { path, stat } = this.file(entry.path, 'write');
      const actual = stat ? fileState(path) : null;
      if (!sameState(actual, entry.after))
        throw new Error(`Rollback conflict: ${entry.path} changed outside this run`);
      return { path, entry };
    });

    function restore(path: string, value: FileState | null): void {
      if (value) replaceFile(path, Buffer.from(value.content, 'base64'), value.mode);
      else if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path);
    }

    const applied: typeof prepared = [];
    try {
      for (const item of prepared) {
        restore(item.path, item.entry.before);
        applied.push(item);
      }
    } catch (error) {
      for (const item of applied.reverse()) restore(item.path, item.entry.after);
      throw error;
    }
  }
}
