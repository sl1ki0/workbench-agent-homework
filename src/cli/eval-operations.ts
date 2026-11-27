import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extendedScenarios, scenarios } from '../../eval/cases.js';
import { writeReport } from '../../eval/report.js';
import { executeTrials, trialsPerVariant, type TrialRow } from '../../eval/runner.js';
import { atomicJson, isMissing } from '../market/files.js';
import type { Terminal } from './format.js';
import type { CliOptions } from './options.js';

interface EvalJob {
  id: string;
  suite: 'base' | 'extended';
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  completedTrials: number;
  totalTrials: number;
  output: string;
  pid?: number;
  error?: string;
  lastTrial?: Pick<TrialRow, 'case_id' | 'variant' | 'trial' | 'status' | 'outcome_pass'>;
}

type Input = Record<string, unknown>;
type Launcher = (directory: string, error: (cause: unknown) => void) => void;
const statusFile = 'status.json';
const workerPath = fileURLToPath(import.meta.url);
const jobPattern = /^eval-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;

function selectSuite(suite: unknown): EvalJob['suite'] {
  if (suite === undefined || suite === 'base') return 'base';
  if (suite === 'extended') return suite;
  throw new Error('Используйте набор base или extended');
}

function cases(suite: EvalJob['suite']) {
  return suite === 'extended' ? extendedScenarios : scenarios;
}

function errorMessage(source: unknown): string {
  return source instanceof Error ? source.message : String(source);
}

function read(directory: string): EvalJob {
  return JSON.parse(readFileSync(join(directory, statusFile), 'utf8')) as EvalJob;
}

function save(directory: string, job: EvalJob): void {
  job.updatedAt = new Date().toISOString();
  atomicJson(join(directory, statusFile), job);
}

function active(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function open(directory: string): EvalJob {
  const job = read(directory);
  if (
    (job.status === 'running' && !active(job.pid)) ||
    (job.status === 'queued' && Date.now() - Date.parse(job.updatedAt) > 60_000)
  ) {
    return {
      ...job,
      status: 'failed',
      error: 'Процесс оценки остановился. Частичные результаты сохранены.',
    };
  }
  return job;
}

function list(root: string): EvalJob[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && jobPattern.test(entry.name))
    .flatMap(({ name }) => {
      try {
        return [open(join(root, name))];
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    })
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
}

function launchJob(directory: string, error: (cause: unknown) => void): void {
  const worker = spawn(process.execPath, [workerPath, directory], {
    detached: true,
    stdio: 'ignore',
  });
  worker.once('error', error);
  worker.unref();
}

function queue(root: string, suite: EvalJob['suite'], launch: Launcher): EvalJob {
  const id = `eval-${randomUUID()}`;
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const job: EvalJob = {
    id,
    suite,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    completedTrials: 0,
    totalTrials: cases(suite).length * trialsPerVariant * 2,
    output: join(directory, 'results'),
  };
  save(directory, job);
  const failure = (error: unknown) => {
    job.status = 'failed';
    job.error = errorMessage(error);
    save(directory, job);
  };
  try {
    launch(directory, failure);
  } catch (error) {
    failure(error);
  }
  return job;
}

function report(root: string, id: unknown) {
  if (typeof id !== 'string' || !jobPattern.test(id)) throw new Error('Укажите ID запуска eval');
  const directory = join(root, id);
  const job = open(directory);
  const reportPath = join(directory, 'results', 'report.md');
  const content = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  return { job, content };
}

export function evaluationOperations(options: CliOptions, launch: Launcher = launchJob) {
  const root = join(options.stateDir, 'evals');
  return {
    list: () => list(root),
    run: (input: Input) => queue(root, selectSuite(input.suite), launch),
    report: (input: Input) => report(root, input.id),
  };
}

export function runEvaluationCommand(
  args: string[],
  options: CliOptions,
  terminal: Terminal,
): number {
  const [action = 'list', argument, ...rest] = args;
  const ops = evaluationOperations(options);
  if (rest.length || (action === 'list' && argument !== undefined)) {
    throw new Error('Используйте eval list | run [base|extended] | report ID');
  }
  if (action === 'report') {
    const result = ops.report({ id: argument });
    if (terminal.json) terminal.printJson(result);
    else terminal.note(result.content ?? JSON.stringify(result.job, null, 2));
    return result.job.status === 'failed' ? 1 : 0;
  }
  if (action !== 'list' && action !== 'run')
    throw new Error('Используйте eval list | run | report');
  const result = action === 'list' ? ops.list() : ops.run({ suite: argument });
  if (terminal.json) terminal.printJson(result);
  else terminal.note(JSON.stringify(result, null, 2));
  return 0;
}

async function executeJob(directory: string): Promise<void> {
  const job = read(directory);
  if (job.status !== 'queued') throw new Error('Запуск eval уже начат');
  const suite = cases(selectSuite(job.suite));
  const output = join(directory, 'results');
  job.status = 'running';
  job.pid = process.pid;
  save(directory, job);
  try {
    await executeTrials(output, undefined, undefined, {
      suite,
      onTrial({ case_id, variant, trial, status, outcome_pass }) {
        job.completedTrials += 1;
        job.lastTrial = { case_id, variant, trial, status, outcome_pass };
        save(directory, job);
      },
    });
    writeReport(output);
    job.status = 'completed';
  } catch (error) {
    job.status = 'failed';
    job.error = errorMessage(error);
    if (existsSync(join(output, 'manifest.json'))) {
      try {
        writeReport(output);
      } catch {
        // Preserve the experiment error if available artifacts cannot yet be summarized.
      }
    }
  } finally {
    save(directory, job);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === workerPath) {
  if (!process.argv[2]) throw new Error('Укажите каталог запуска eval');
  await executeJob(resolve(process.argv[2]));
}
