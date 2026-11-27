import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkDirectory, isMissing } from './files.js';
import { readRegular } from './registry.js';

const reportId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const maxDecisionBytes = 2 * 1024 * 1024;
const maxReportBytes = 4 * 1024 * 1024;

function readJson(path: string) {
  return JSON.parse(readRegular(path, maxDecisionBytes).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function revision(input: unknown) {
  if (!input || typeof input !== 'object' || !('version' in input)) return null;
  return {
    version: String(input.version),
    name: 'name' in input ? String(input.name) : '',
    registry: 'registry' in input ? String(input.registry) : '',
    digest: 'digest' in input ? String(input.digest) : '',
  };
}

function readEntry(directory: string, id: string) {
  try {
    const decision = readJson(join(directory, 'decision.json'));
    return {
      id,
      allowed: decision.allowed === true,
      status: decision.allowed === true ? 'accepted' : 'rejected',
      time: typeof decision.completedAt === 'string' ? decision.completedAt : '',
      reason: typeof decision.reason === 'string' ? decision.reason : '',
      baseline: revision(decision.baseline),
      candidate: revision(decision.candidate),
      trials: Array.isArray(decision.rows) ? decision.rows.length : 0,
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    const file = join(directory, 'manifest.json');
    try {
      const manifest = readJson(file);
      return {
        id,
        allowed: null,
        status: 'pending',
        time:
          typeof manifest.startedAt === 'string'
            ? manifest.startedAt
            : lstatSync(file).mtime.toISOString(),
        reason: 'Решение пока не сохранено.',
        baseline: revision(manifest.baseline),
        candidate: revision(manifest.candidate),
        trials: null,
      };
    } catch (missing) {
      if (isMissing(missing)) return null;
      throw missing;
    }
  }
}

export function listMarketGates(root: string) {
  try {
    const directory = checkDirectory(join(root, 'gates'));
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && reportId.test(entry.name))
      .map(({ name }) => readEntry(join(directory, name), name))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.time.localeCompare(left.time));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function readMarketGate(root: string, id: string) {
  if (!reportId.test(id)) throw new Error('Некорректный ID проверки обновления');
  const directory = checkDirectory(join(checkDirectory(join(root, 'gates')), id));
  const entry = readEntry(directory, id);
  if (!entry) throw new Error('Проверка обновления не найдена');
  try {
    return {
      ...entry,
      report: readRegular(join(directory, 'report.md'), maxReportBytes).toString('utf8'),
    };
  } catch (error) {
    if (isMissing(error)) return { ...entry, report: null };
    throw error;
  }
}
