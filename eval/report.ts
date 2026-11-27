import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../src/types.js';
import type { TrialRow } from './runner.js';
import type { Variant } from './scoring.js';

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function yes(value: boolean | 'n/a'): string {
  return value === 'n/a' ? value : value ? 'да' : 'нет';
}

function tableCell(value: unknown): string {
  return String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, ' ');
}

function row(cells: unknown[]): string {
  return `| ${cells.map(tableCell).join(' | ')} |`;
}

function tokenAverage(trials: TrialRow[], category: 'input' | 'output'): string {
  const usage = trials.map((trial) => trial.usage?.[category]);
  const complete = usage.filter((value) => value?.status === 'complete');
  const partial = usage.filter((value) => value?.status === 'partial').length;
  const unknown = usage.length - complete.length - partial;
  const average = complete.length
    ? (complete.reduce((sum, value) => sum + (value?.total ?? 0), 0) / complete.length).toFixed(1)
    : 'unknown';
  return `${average} (${complete.length}/${partial}/${unknown})`;
}

function totals(
  trials: TrialRow[],
  field: 'mcp_calls' | 'tool_calls' | 'skill_activations',
): string {
  const counts = new Map<string, number>();
  for (const trial of trials) {
    for (const [name, count] of Object.entries(trial[field]))
      counts.set(name, (counts.get(name) ?? 0) + count);
  }
  const sorted = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
  return sorted.length ? sorted.map(([name, count]) => `${name} × ${count}`).join(', ') : '—';
}

function summary(trials: TrialRow[], caseName: string, variant: Variant): string {
  const selected = trials.filter(
    (trial) => trial.variant === variant && (caseName === 'Все' || trial.case_id === caseName),
  );
  const count = (predicate: (trial: TrialRow) => boolean) => selected.filter(predicate).length;
  return row([
    caseName,
    variant,
    `${count((trial) => trial.outcome_pass)}/${selected.length}`,
    `${count((trial) => trial.tool_pass)}/${selected.length}`,
    `${count((trial) => trial.trial_pass)}/${selected.length}`,
    variant === 'A' ? 'n/a' : count((trial) => trial.routing_pass_or_na === false),
    count((trial) => Boolean(trial.error)),
    tokenAverage(selected, 'input'),
    tokenAverage(selected, 'output'),
    totals(selected, 'skill_activations'),
    totals(selected, 'mcp_calls'),
    totals(selected, 'tool_calls'),
  ]);
}

function trace(output: string, trial: TrialRow): string {
  if (!trial.journal) return 'Журнал не создан.';
  const events = readLines<AgentEvent>(join(output, trial.journal));
  const actions = events.flatMap(({ id, type, data }) => {
    if (type === 'skill_loaded') return [`загружен ${data.name} (${id})`];
    if (type === 'tool_started') {
      const args = (data.args ?? {}) as Record<string, unknown>;
      const target = args.path ?? args.status;
      return [`${data.name}${typeof target === 'string' ? `(${target})` : ''} (${id})`];
    }
    if (type === 'tool_error') return [`ошибка ${data.name} (${id})`];
    return [];
  });
  return [
    `[Журнал](${trial.journal})`,
    actions.length ? actions.join(' → ') : 'вызовов с исполнением нет',
  ].join(' · ');
}

function describeOutcome(output: string, trial: TrialRow): string {
  const details = JSON.parse(
    readFileSync(
      join(output, 'trials', trial.case_id, `${trial.variant}${trial.trial}`, 'result.json'),
      'utf8',
    ),
  ) as { outcome_checks: string[] };
  return details.outcome_checks.join(' ');
}

function hypothesis(trials: TrialRow[], controls: Set<string>): string {
  const count = (variant: Variant, control: boolean) => {
    const selected = trials.filter(
      ({ variant: group, case_id }) => group === variant && controls.has(case_id) === control,
    );
    return {
      passed: selected.filter(({ outcome_pass }) => outcome_pass).length,
      total: selected.length,
    };
  };
  const a = count('A', false);
  const b = count('B', false);
  const controlA = count('A', true);
  const controlB = count('B', true);
  const confirmed = b.passed > a.passed && controlB.passed >= controlA.passed;
  return `Гипотеза о качестве ${confirmed ? 'подтвердилась' : 'не подтвердилась'} в этой серии. В сценариях со скиллами получено ${a.passed}/${a.total} корректных артефактов в A и ${b.passed}/${b.total} в B. В контрольных сценариях получено ${controlA.passed}/${controlA.total} в A и ${controlB.passed}/${controlB.total} в B.`;
}

function tokenFinding(trials: TrialRow[], controls: Set<string>): string {
  const applicable = trials.filter(({ case_id }) => !controls.has(case_id));
  if (!applicable.length || applicable.some(({ usage }) => usage?.input.status !== 'complete')) {
    return 'Доступность usage ограничивает сравнение. В сводке приведены известные значения расхода.';
  }
  const average = (variant: Variant) => {
    const selected = applicable.filter((trial) => trial.variant === variant);
    return selected.reduce((sum, trial) => sum + (trial.input_tokens ?? 0), 0) / selected.length;
  };
  const a = average('A');
  const b = average('B');
  return `В сценариях со скиллами средний входной расход составил ${a.toFixed(1)} токена в A и ${b.toFixed(1)} в B. Ожидание роста расхода ${b > a ? 'подтвердилось' : 'не подтвердилось'}.`;
}

interface ManifestSummary {
  experiment: 'smoke' | 'A/B' | 'mock';
  order: [string, Variant, number][];
  scenarios?: { id: string; expectedSkill: string | null }[];
  model: { model: string; temperature: number; maxTokens: number; timeoutMs: number };
}

export function writeReport(output: string): void {
  const manifest = JSON.parse(
    readFileSync(join(output, 'manifest.json'), 'utf8'),
  ) as ManifestSummary;
  const trials = readLines<TrialRow>(join(output, 'trials.jsonl'));
  const ids = [...new Set(manifest.order.map(([id]) => id))];
  const expected = manifest.order.length;
  const controls = new Set(
    manifest.scenarios?.filter(({ expectedSkill }) => !expectedSkill).map(({ id }) => id) ?? [
      'no-skill',
    ],
  );
  const completeSeries =
    manifest.experiment === 'A/B' &&
    existsSync(join(output, 'completion.json')) &&
    expected > 0 &&
    trials.length === expected &&
    trials.every(({ run_id }) => run_id !== null) &&
    new Set(trials.map(({ run_id }) => run_id)).size === expected &&
    new Set(trials.map(({ session_id }) => session_id)).size === expected &&
    trials.every((trial, index) => {
      const [id, variant, number] = manifest.order[index] ?? [];
      return trial.case_id === id && trial.variant === variant && trial.trial === number;
    });
  const lines = [
    '# Результаты A/B',
    '',
    `Модель «${manifest.model.model}». Температура ${manifest.model.temperature}, лимит ответа ${manifest.model.maxTokens} токенов, таймаут ${manifest.model.timeoutMs} мс.`,
    '',
    manifest.experiment === 'mock'
      ? 'Детерминированная проверка стенда с тестовым адаптером. Данные этой проверки не входят в эксперимент.'
      : manifest.experiment === 'smoke'
        ? 'Пробный запуск вне основной серии.'
        : `Сохранено ${trials.length} из ${expected} попыток.`,
    '',
    '## Сводка',
    '',
    'Средний расход рассчитан по попыткам с полным usage. Числа в скобках показывают количество попыток с полным, частичным и неизвестным usage.',
    '',
    row([
      'Сценарий',
      'Версия',
      'Артефакт',
      'Инструменты',
      'Полный зачёт',
      'Ошибки выбора',
      'Ошибки запуска',
      'Входные токены',
      'Выходные токены',
      'Скиллы',
      'MCP',
      'Инструменты по имени',
    ]),
    row(Array.from({ length: 12 }, () => '---')),
    ...['Все', ...ids].flatMap((id) => [summary(trials, id, 'A'), summary(trials, id, 'B')]),
    '',
    '## Попытки',
    '',
    row([
      'Сценарий',
      'Версия',
      '№',
      'Run ID',
      'Артефакт',
      'Выбор',
      'Инструменты',
      'Входные',
      'Выходные',
      'Статус',
      'Ошибка',
    ]),
    row(Array.from({ length: 11 }, () => '---')),
    ...trials.map((trial) =>
      row([
        trial.case_id,
        trial.variant,
        trial.trial,
        trial.journal ? `[${trial.run_id}](${trial.journal})` : (trial.run_id ?? '—'),
        yes(trial.outcome_pass),
        yes(trial.routing_pass_or_na),
        yes(trial.tool_pass),
        trial.input_tokens ?? 'unknown',
        trial.output_tokens ?? 'unknown',
        trial.status,
        trial.error ?? '—',
      ]),
    ),
  ];
  for (const id of ids) {
    const first = trials.find(
      (trial) => trial.case_id === id && trial.variant === 'A' && trial.trial === 1,
    );
    const second = trials.find(
      (trial) => trial.case_id === id && trial.variant === 'B' && trial.trial === 1,
    );
    if (!first || !second) continue;
    lines.push(
      '',
      `## ${id}, пара A1/B1`,
      '',
      `- A1 · ${trace(output, first)}. ${describeOutcome(output, first)}`,
      `- B1 · ${trace(output, second)}. ${describeOutcome(output, second)}`,
      '',
      first.outcome_pass === second.outcome_pass
        ? 'В этой паре итог проверки артефакта совпал. Последовательность действий позволяет сравнить нагрузку и выбор скилла.'
        : `В этой паре корректный артефакт получен в ${second.outcome_pass ? 'B1' : 'A1'}. Критерий, на котором разошлись результаты, приведён в проверке артефакта.`,
    );
  }
  if (completeSeries)
    lines.push(
      '',
      '## Вывод',
      '',
      hypothesis(trials, controls),
      '',
      tokenFinding(trials, controls),
      '',
      'Результат относится к этому набору сценариев и локальной модели. Три попытки на вариант в сценарии ограничивают обобщение.',
    );
  else if (manifest.experiment === 'A/B')
    lines.push(
      '',
      'Вывод требует полной серии с уникальными сессиями и run_id и подтверждёнными контрольными суммами.',
    );
  writeFileSync(join(output, 'report.md'), `${lines.join('\n')}\n`);
}
