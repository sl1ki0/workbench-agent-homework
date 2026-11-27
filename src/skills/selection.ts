import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillSelection {
  enabled: boolean;
  disabled: string[];
}

const filename = 'skills-selection.json';

export function isSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

function selection(value: unknown): SkillSelection {
  const data =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (
    typeof data.enabled !== 'boolean' ||
    !Array.isArray(data.disabled) ||
    !data.disabled.every(isSkillName)
  ) {
    throw new Error('Настройки скиллов должны содержать enabled и массив имён disabled');
  }
  return { enabled: data.enabled, disabled: [...new Set(data.disabled)].sort() };
}

export function readSkillSelection(stateDir: string): SkillSelection {
  const path = join(stateDir, filename);
  try {
    return selection(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true, disabled: [] };
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Не удалось прочитать настройки скиллов (${path}) · ${detail}`, {
      cause: error,
    });
  }
}

export function writeSkillSelection(stateDir: string, input: SkillSelection): void {
  const data = selection(input);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, filename);
  const temporary = join(stateDir, `.${filename}.${randomUUID()}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
