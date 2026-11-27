import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { extendedScenarios, type EvaluationCase } from '../../eval/cases.js';
import {
  evaluationChecksums,
  limits,
  mode,
  runEvaluationTrial,
  trialQueue,
  trialsPerVariant,
  type TrialRow,
  type TrialSpec,
} from '../../eval/runner.js';
import { installationRoot } from '../cli/paths.js';
import type { ModelSettings } from '../model/index.js';
import type { AgentEvent, Model } from '../types.js';
import { atomicJson } from './files.js';
import type { Market } from './index.js';
import type { InstalledVersion } from './types.js';
import { calculateDigest, compareVersions } from './validation.js';

export interface UpdateEvaluation {
  market: Market;
  candidate: InstalledVersion;
  baseline: InstalledVersion | null;
  output: string;
  model: Model & { settings?: ModelSettings };
  skillRoots?: string[];
  onTrial?(row: TrialRow): void;
}

export interface UpdateDecision {
  allowed: boolean;
  reason: string;
  reasons: string[];
  evidence: string;
  decisionFile: string;
  reportFile: string;
  comparison: ScenarioComparison[];
  rows: TrialRow[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verifyVersion(market: Market, expected: InstalledVersion): void {
  const installed = market.version(expected.name, expected.version);
  if (
    installed.digest !== expected.digest ||
    installed.root !== expected.root ||
    installed.registry !== expected.registry
  )
    throw new Error(`Version has changed: ${expected.name}@${expected.version}`);
}

function verifyPair(market: Market, baseline: InstalledVersion, candidate: InstalledVersion): void {
  if (
    candidate.name !== baseline.name ||
    candidate.registry !== baseline.registry ||
    compareVersions(candidate.version, baseline.version) <= 0
  ) {
    throw new Error('Candidate must be a newer release of the same skill and registry');
  }
  verifyVersion(market, baseline);
  verifyVersion(market, candidate);
  const active = market.active().find(({ name }) => name === baseline.name);
  if (active?.digest !== baseline.digest || active.version !== baseline.version) {
    throw new Error('Active version changed during evaluation');
  }
}

function skillDocuments(root: string): string[] {
  if (!lstatSync(root).isDirectory()) throw new Error('Skill root is not a regular directory');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'SKILL.md'))
    .filter((document) => {
      try {
        return lstatSync(document).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
}

function freezeSources(roots: string[]): Record<string, string> {
  const skillFiles = [...new Set(roots.flatMap(skillDocuments))].sort();
  const extraFiles = [...skillFiles, join(installationRoot, 'src/market/gate.ts')];
  return {
    ...evaluationChecksums(),
    ...Object.fromEntries(
      extraFiles.map((file) => [
        relative(installationRoot, file),
        calculateDigest(readFileSync(file)),
      ]),
    ),
  };
}

function saveVersion(output: string, variant: 'A' | 'B', version: InstalledVersion): void {
  const bytes = readFileSync(join(version.root, version.name, 'SKILL.md'));
  if (calculateDigest(bytes) !== version.digest) {
    throw new Error(`Skill digest does not match ${version.name}@${version.version}`);
  }
  const directory = join(output, 'versions', variant, version.name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'SKILL.md'), bytes, { flag: 'wx', mode: 0o600 });
}

const acceptance = [
  'Ровно пять сценариев и по три независимых попытки каждой версии с журналами.',
  'Кандидат сохраняет или повышает число полных зачётов в каждом сценарии и получает минимум один зачёт в каждом.',
  'Каждая попытка кандидата проходит проверку инструментов и не содержит отказов policy.',
  'Расход токенов сравнивается по полным метрикам и не ограничивает допуск. Приоритет учебной проверки — корректность и соблюдение ограничений.',
];

interface Metrics {
  trials: number;
  passed: number;
  artifactPass: number;
  routingPass: number;
  toolPass: number;
  input: number | null;
  output: number | null;
  completeUsage: number;
}

interface ScenarioComparison {
  caseId: string;
  baseline: Metrics;
  candidate: Metrics;
}

function summarize(rows: TrialRow[]): Metrics {
  const complete = rows.filter(
    ({ usage }) => usage?.input.status === 'complete' && usage.output.status === 'complete',
  );
  const average = (key: 'input_tokens' | 'output_tokens') =>
    complete.length
      ? complete.reduce((total, row) => total + (row[key] ?? 0), 0) / complete.length
      : null;
  return {
    trials: rows.length,
    passed: rows.filter(({ trial_pass }) => trial_pass).length,
    artifactPass: rows.filter(({ outcome_pass }) => outcome_pass).length,
    routingPass: rows.filter(({ routing_pass_or_na }) => routing_pass_or_na === true).length,
    toolPass: rows.filter(({ tool_pass }) => tool_pass).length,
    input: average('input_tokens'),
    output: average('output_tokens'),
    completeUsage: complete.length,
  };
}

function compare(cases: EvaluationCase[], rows: TrialRow[]): ScenarioComparison[] {
  return cases.map(({ id }) => {
    const by = (variant: 'A' | 'B') =>
      rows.filter((row) => row.case_id === id && row.variant === variant);
    return { caseId: id, baseline: summarize(by('A')), candidate: summarize(by('B')) };
  });
}

function readEvents(evidence: string, journal: string): AgentEvent[] {
  return readFileSync(join(evidence, journal), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentEvent);
}

function compareResults(
  planned: TrialSpec[],
  rows: TrialRow[],
  comparison: ScenarioComparison[],
  evidence: string,
): string[] {
  const problems: string[] = [];
  if (
    rows.length !== planned.length ||
    new Set(rows.map(({ run_id }) => run_id)).size !== planned.length ||
    new Set(rows.map(({ session_id }) => session_id)).size !== planned.length ||
    rows.some((row, index) => {
      const spec = planned[index];
      return (
        !spec ||
        row.variant !== spec.variant ||
        row.trial !== spec.trial ||
        row.case_id !== spec.scenario.id ||
        !row.run_id ||
        !row.session_id ||
        !row.journal
      );
    })
  )
    problems.push('Evaluation run coverage, identities or evidence are incomplete');

  for (const { caseId, baseline, candidate } of comparison) {
    if (candidate.passed < baseline.passed) {
      problems.push(
        `${caseId}: regression against active version (${baseline.passed} → ${candidate.passed})`,
      );
    }
    if (candidate.passed === 0) problems.push(`${caseId}: candidate has no passing trials`);
  }
  for (const row of rows.filter(({ variant }) => variant === 'B')) {
    if (!row.tool_pass) problems.push(`${row.case_id} B${row.trial}: tool checks failed`);
    if (!row.journal) continue;
    const denied = readEvents(evidence, row.journal).filter(({ type }) => type === 'tool_denied');
    if (denied.length)
      problems.push(
        `${row.case_id} B${row.trial}: policy denial ${denied.map(({ id }) => id).join(', ')}`,
      );
  }
  return problems;
}

function versionEvidence(version: InstalledVersion | null) {
  if (!version) return null;
  const { name, version: tag, registry, digest } = version;
  return { name, version: tag, registry, digest };
}

function metric(value: number | null): string {
  return value === null ? 'unknown' : value.toFixed(1);
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/gu, ' ');
}

function writeReport(
  output: string,
  decision: UpdateDecision,
  baseline: InstalledVersion | null,
  candidate: InstalledVersion,
): void {
  const totals = [
    summarize(decision.rows.filter(({ variant }) => variant === 'A')),
    summarize(decision.rows.filter(({ variant }) => variant === 'B')),
  ];
  const lines = [
    '# Проверка обновления скилла',
    '',
    `Кандидат \`${candidate.name}@${candidate.version}\`, далее B. Активная версия \`${baseline?.version ?? 'отсутствует'}\`, далее A. Скиллы включены в обеих версиях.`,
    '',
    `Решение программы · **${decision.allowed ? 'допустить' : 'отклонить'}**`,
    '',
    ...decision.reasons.map((reason) => `- ${reason}`),
    ...(decision.allowed ? ['- Все условия допуска выполнены.'] : []),
    '',
    'Предварительное правило:',
    '',
    ...acceptance.map((rule) => `- ${rule}`),
    '',
    ...(baseline && decision.rows.length
      ? [
          `[Старая версия](versions/A/${baseline.name}/SKILL.md) · [Новая версия](versions/B/${candidate.name}/SKILL.md)`,
          '',
        ]
      : []),
    '| Сценарий | Версия | Полные зачёты | Артефакт | Маршрут | Инструменты | Среднее входных | Среднее выходных | Полный usage |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[
      ...decision.comparison,
      { caseId: 'Всего', baseline: totals[0]!, candidate: totals[1]! },
    ].flatMap(({ caseId, baseline: old, candidate: next }) =>
      [old, next].map(
        (data, index) =>
          `| ${caseId} | ${index ? 'B' : 'A'} | ${data.passed}/${data.trials} | ${data.artifactPass} | ${data.routingPass} | ${data.toolPass} | ${metric(data.input)} | ${metric(data.output)} | ${data.completeUsage}/${data.trials} |`,
      ),
    ),
    '',
    '## Попытки',
    '',
    '| Сценарий | Вариант | Журнал | Артефакт | Итог | Токены вход/выход | Ошибка |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...decision.rows.map(
      (row) =>
        `| ${row.case_id} | ${row.variant}${row.trial} | ${row.journal ? `[${row.run_id}](${row.journal})` : '—'} | ${row.artifact ? `[файл](${row.artifact})` : '—'} | ${row.trial_pass ? 'зачёт' : 'нет'} | ${row.input_tokens ?? 'unknown'}/${row.output_tokens ?? 'unknown'} | ${markdownCell(row.error ?? '—')} |`,
    ),
    '',
    'Файлы: [манифест](manifest.json), [таблица JSONL](trials.jsonl), [решение](decision.json).',
    '',
  ];
  writeFileSync(join(output, 'report.md'), lines.join('\n'));
}

function prepareDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || readdirSync(directory).length) {
    throw new Error('Evaluation output requires an empty directory');
  }
  return realpathSync(directory);
}

export async function evaluateUpdate(options: UpdateEvaluation): Promise<UpdateDecision> {
  const { market, baseline, candidate, model } = options;
  const evidence = prepareDirectory(options.output);
  const decisionFile = join(evidence, 'decision.json');
  const reportFile = join(evidence, 'report.md');
  const rows: TrialRow[] = [];
  const startedAt = new Date().toISOString();
  let reasons: string[];
  try {
    if (!baseline) throw new Error('No active baseline to evaluate against');
    verifyPair(market, baseline, candidate);
    const scenarios = extendedScenarios;
    if (scenarios.length !== 5 || trialsPerVariant !== 3)
      throw new Error('Version evaluation requires the full 30-trial suite');
    const sharedRoots = [
      ...market
        .active()
        .filter(({ name }) => name !== candidate.name)
        .map(({ root }) => root),
      ...(options.skillRoots ?? [join(installationRoot, 'skills')]),
    ];
    const oldRoots = [baseline.root, ...sharedRoots];
    const candidateRoots = [candidate.root, ...sharedRoots];
    const usedRoots = [...new Set([...oldRoots, ...candidateRoots])];
    const snapshots = freezeSources(usedRoots);
    const planned: TrialSpec[] = trialQueue(scenarios).map((trial) => ({
      ...trial,
      routingVariant: 'B',
      skillDirectories: trial.variant === 'A' ? oldRoots : candidateRoots,
    }));
    saveVersion(evidence, 'A', baseline);
    saveVersion(evidence, 'B', candidate);
    atomicJson(join(evidence, 'manifest.json'), {
      schema: 1,
      startedAt,
      experiment: 'version-update',
      baseline: versionEvidence(baseline),
      candidate: versionEvidence(candidate),
      acceptance,
      configurations: { A: { skills: true }, B: { skills: true } },
      order: planned.map(({ scenario, variant, trial }) => [scenario.id, variant, trial]),
      mode,
      limits,
      model: model.settings ?? null,
      scenarios: scenarios.map(({ id, prompt, source, artifact, expectedSkill }) => ({
        id,
        prompt,
        source: source ?? null,
        artifact,
        expectedSkill,
      })),
      sourceDigests: snapshots,
    });
    for (const trial of planned) {
      const row = await runEvaluationTrial(trial, evidence, model);
      rows.push(row);
      options.onTrial?.(row);
    }
    verifyPair(market, baseline, candidate);
    if (JSON.stringify(snapshots) !== JSON.stringify(freezeSources(usedRoots))) {
      throw new Error('Evaluation inputs changed while it was running');
    }
    reasons = compareResults(planned, rows, compare(scenarios, rows), evidence);
  } catch (error) {
    reasons = [reasonOf(error)];
  }
  const allowed = reasons.length === 0;
  const reason = allowed
    ? 'Candidate passed all required checks against the active version'
    : reasons.join('; ');
  const comparison = compare(extendedScenarios, rows);
  const result = { allowed, reason, reasons, evidence, decisionFile, reportFile, rows, comparison };
  atomicJson(decisionFile, {
    schema: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    baseline: versionEvidence(baseline),
    candidate: versionEvidence(candidate),
    allowed,
    reason,
    reasons,
    comparison,
    rows,
  });
  writeReport(evidence, result, baseline, candidate);
  return result;
}
