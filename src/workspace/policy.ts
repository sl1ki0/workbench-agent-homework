import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface Policy {
  commands: { allow: string[]; deny: string[] };
  directories: { allow: string[]; deny: string[] };
  files?: { readOnly: string[] };
  bash?: { timeoutMs: number; maxOutputBytes: number };
}

export function relativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isAbsolute(value) ||
    /[:\\\p{Cc}]/u.test(value) ||
    (value !== '.' && value.split('/').some((part) => ['', '.', '..'].includes(part)))
  ) {
    throw new Error(
      `Expected a workspace-relative path without traversal: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Policy ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`Policy ${field} must be an array of nonempty strings`);
  }
  return value as string[];
}

function positiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new Error(`Policy ${field} must be an integer between 1 and 2147483647`);
  }
  return value;
}

export function readPolicy(path: string): Policy {
  const configuration = object(JSON.parse(readFileSync(path, 'utf8')), 'root');
  const commands = object(configuration.commands, 'commands');
  const directories = object(configuration.directories, 'directories');
  const policy: Policy = {
    commands: {
      allow: strings(commands.allow, 'commands.allow'),
      deny: strings(commands.deny, 'commands.deny'),
    },
    directories: {
      allow: strings(directories.allow, 'directories.allow').map(relativePath),
      deny: strings(directories.deny, 'directories.deny').map(relativePath),
    },
  };
  if (configuration.files !== undefined) {
    policy.files = {
      readOnly: strings(object(configuration.files, 'files').readOnly, 'files.readOnly').map(
        relativePath,
      ),
    };
  }
  if (configuration.bash !== undefined) {
    const bash = object(configuration.bash, 'bash');
    policy.bash = {
      timeoutMs: positiveInteger(bash.timeoutMs, 'bash.timeoutMs'),
      maxOutputBytes: positiveInteger(bash.maxOutputBytes, 'bash.maxOutputBytes'),
    };
  }
  return policy;
}

export function contains(parent: string, child: string): boolean {
  return parent === '.' || child === parent || child.startsWith(`${parent}/`);
}

const processLaunchers = new Set([
  'ash',
  'bash',
  'busybox',
  'command',
  'dash',
  'doas',
  'env',
  'eval',
  'exec',
  'fish',
  'ksh',
  'nohup',
  'sh',
  'source',
  'sudo',
  'tcsh',
  'time',
  'xargs',
  'zsh',
]);
const executionFlags = new Set(['-c', '-e', '--command', '--eval', '--execute']);

export function commandTokens(command: string, policy: Policy): string[] {
  if (policy.commands.deny.includes(command) || !policy.commands.allow.includes(command)) {
    throw new Error(`Bash command denied by policy: ${JSON.stringify(command)}`);
  }
  const tokens = command.split(' ');
  const [executable, ...args] = tokens;
  if (
    !executable ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(executable) ||
    processLaunchers.has(executable) ||
    args.some(
      (token) =>
        !/^[A-Za-z0-9_.-]+$/.test(token) ||
        token === '.' ||
        token === '..' ||
        executionFlags.has(token),
    )
  ) {
    throw new Error('Bash accepts only an executable and simple, literal arguments');
  }
  return tokens;
}
