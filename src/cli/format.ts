import { stripVTControlCharacters } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import type { AgentEvent } from '../types.js';
import type { Run, SessionStats } from '../runtime/types.js';
import type { ModelSettings } from '../model/index.js';
import type { FileChange } from '../workspace/index.js';

export type CliRun = Run;

const statuses: Record<string, string> = {
  running: 'выполняется',
  completed: 'завершён',
  failed: 'ошибка',
  budget_exhausted: 'исчерпан бюджет',
  awaiting_confirmation: 'ждёт подтверждения',
  awaiting_plan: 'ждёт утверждения плана',
  uncertain: 'нужно восстановление',
  pending: 'ожидает',
  active: 'выполняется',
};

export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
}

function shorten(value: unknown, max = 180): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const text = terminalText(json ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function eventTarget(data: AgentEvent['data']): string {
  const server = shorten(data.server);
  return server ? `${server}/${shorten(data.tool)}` : shorten(data.name);
}

function usageLine(usage: CliRun['usage']): string {
  const format = (metric: CliRun['usage']['input']) => {
    if (metric.total === null) return 'unknown';
    return metric.status === 'partial'
      ? `${metric.total} (частично, ${metric.known}/${metric.requests})`
      : String(metric.total);
  };
  const main = `вход ${format(usage.input)} · выход ${format(usage.output)}`;
  const details = [];
  if (usage.cached.total !== null) details.push(`кэш ${format(usage.cached)}`);
  if (usage.reasoning.total !== null) details.push(`рассуждения ${format(usage.reasoning)}`);
  return [main, ...details].join(' · ');
}

const helpLines = [
  '  chat                         Диалог с агентом, режим по умолчанию',
  '  start "задача"               Запустить задачу один раз',
  '  resume RUN_ID                Продолжить остановленный запуск',
  '  stats SESSION_ID             Показать статистику сессии',
  '  tasks RUN_ID                 Показать план и состояние задач',
  '  diff RUN_ID                  Посмотреть изменения файлов',
  '  rollback RUN_ID              Откатить изменения запуска',
  '',
  '  --mode safe|auto             Подтверждать действия или выполнять разрешённые',
  '  --plan                       Подготовить план перед выполнением',
  '  --session SESSION_ID         Продолжить существующий диалог',
  '  --decision approve|deny|retry|skip|abort',
  '  --attribute yes|no           Отнести изменения при сбое к запуску',
  '  --workspace PATH             Корень проекта (workspace)',
  '  --policy PATH                Настройки доступа (config/policy.json)',
  '  --state-dir PATH             История и журналы (.agent)',
  '  --skills-dir PATH            Каталог скиллов (skills), флаг можно повторять',
  '  --no-skills                  Запуск без скиллов',
  '  --mcp-config PATH            Конфигурация MCP (config/mcp.json)',
  '  --no-mcp                     Запуск без MCP',
  '  --model-calls N --tool-calls N --side-effects N --result-bytes N',
  '  --json                       Машиночитаемый вывод команд',
  '  --no-color                   Отключить цвета',
];

function tone(enabled: boolean, code: string, value: string): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function counts(values: Record<string, number>): string {
  return (
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name} ×${count}`)
      .join(' · ') || '—'
  );
}

function diffText(path: string, before: string | null, after: string | null): string[] {
  const left = before === null ? '/dev/null' : `a/${path}`;
  const right = after === null ? '/dev/null' : `b/${path}`;
  const oldBuffer = Buffer.from(before ?? '', 'base64');
  const newBuffer = Buffer.from(after ?? '', 'base64');
  if (oldBuffer.includes(0) || newBuffer.includes(0)) return [`Двоичный файл ${path}`];
  if (oldBuffer.equals(newBuffer)) return [];
  return createTwoFilesPatch(left, right, oldBuffer.toString('utf8'), newBuffer.toString('utf8'))
    .replace(/\n$/u, '')
    .split('\n')
    .filter((line) => !line.startsWith('='));
}

export class Terminal {
  constructor(
    readonly color: boolean,
    readonly json: boolean,
  ) {}

  help(extraHelp: string[] = []) {
    const [commands, flags] = helpLines.join('\n').split('\n\n');
    console.log(
      `${this.accent('Агент · терминал')}\n\n${commands}${extraHelp.length ? `\n${extraHelp.join('\n')}` : ''}\n\n${flags}`,
    );
  }

  start(settings: ModelSettings, mode: string, session?: string) {
    const title = this.accent('◆ Агент');
    const divider = tone(this.color, '2', '─'.repeat(54));
    console.log(
      `${title}  ${divider}\n${terminalText(settings.model)} · ${settings.provider} · ${mode}`,
    );
    if (session) console.log(`Сессия ${terminalText(session)}`);
    console.log('/help — команды · /exit — выход\n');
  }

  accent(value: string) {
    return tone(this.color, '1;36', value);
  }

  note(value: string) {
    if (!this.json) console.log(terminalText(value));
  }

  error(value: unknown) {
    const message = value instanceof Error ? value.message : String(value);
    console.error(tone(this.color, '1;31', `Ошибка · ${terminalText(message)}`));
  }

  event(event: AgentEvent) {
    if (this.json) return;
    const { type, data } = event;
    const target = eventTarget(data);
    switch (type) {
      case 'model_request':
        console.log(`  ${this.accent('⋯')} Модель · запрос ${shorten(data.request)}`);
        break;
      case 'tool_call': {
        const source = data.args ?? parseToolArguments(data.arguments);
        const args = Object.fromEntries(
          Object.entries(record(source)).map(([key, value]) => [
            key,
            key === 'content' && typeof value === 'string'
              ? `<${Buffer.byteLength(value)} байт>`
              : value,
          ]),
        );
        console.log(`  ${this.accent('→')} ${target} ${shorten(args, 125)}`);
        break;
      }
      case 'tool_result': {
        const result = record(data.result);
        if (result.ok) {
          console.log(
            `  ${tone(this.color, '32', '✓')} ${target}${result.truncated ? ' · результат обрезан' : ''}`,
          );
        }
        break;
      }
      case 'tool_error':
        console.log(
          `  ${tone(this.color, '33', '!')} ${target} · ${shorten(data.error ?? record(data.result).error)}`,
        );
        break;
      case 'skill_discovered':
      case 'skills_discovered':
        {
          const names = Array.isArray(data.skills)
            ? data.skills.map((skill) => record(skill).name)
            : data.names;
          console.log(
            `  ${this.accent('✦')} Каталог скиллов · ${shorten(data.count)} · ${shorten(names ?? data.name)}`,
          );
        }
        break;
      case 'skill_loaded':
        console.log(`  ${this.accent('✦')} Скилл загружен · ${shorten(data.name)}`);
        break;
      case 'skill_error':
        console.log(
          `  ${tone(this.color, '33', '!')} Скилл · ${shorten(data.path)} · ${shorten(data.error)}`,
        );
        break;
      case 'mcp_connected':
        console.log(
          `  ${this.accent('↔')} MCP · ${shorten(data.server)} · инструменты ${shorten(data.tools)}`,
        );
        break;
      case 'mcp_error':
        console.log(
          `  ${tone(this.color, '33', '!')} MCP · ${shorten(data.server)} · ${shorten(data.error)}`,
        );
        break;
    }
  }

  run(run: CliRun) {
    if (this.json) return this.printJson(run);
    this.note(
      `\n${statuses[run.status] ?? run.status} · запуск ${run.id} · сессия ${run.sessionId}`,
    );
    if (run.final) this.note(`\n${run.final}\n`);
    if (run.error) this.error(run.error);
    if (run.status === 'awaiting_plan') this.tasks(run);
    if (run.pending) {
      const { call, changes } = run.pending;
      this.note(`Ожидает · ${call.function.name} ${shorten(call.function.arguments, 700)}`);
      if (changes?.length) {
        this.note('Обнаружены изменения перед восстановлением:');
        this.diff(changes);
      }
    }
    this.note(`Модель · ${usageLine(run.usage)} · запросы ${run.spent.modelCalls}\n`);
  }

  tasks(run: CliRun) {
    if (this.json) return this.printJson({ run_id: run.id, plan: run.plan, tasks: run.tasks });
    if (run.plan) {
      this.note(`Цель · ${run.plan.goal}`);
      this.note(`Готовность · ${run.plan.doneCriteria}`);
      if (run.plan.risks.length) this.note(`Риски · ${run.plan.risks.join(' · ')}`);
      if (run.plan.assumptions.length) this.note(`Допущения · ${run.plan.assumptions.join(' · ')}`);
    }
    if (!run.tasks.length && !run.plan) this.note('У запуска нет задач плана.');
    const steps = run.tasks.length
      ? run.tasks
      : (run.plan?.steps ?? []).map((step) => ({
          ...step,
          status: 'pending',
          evidenceCallId: undefined,
        }));
    for (const task of steps) {
      const dependencies = task.dependsOn.length ? ` ← ${task.dependsOn.join(', ')}` : '';
      this.note(
        `  ${task.id} · ${statuses[task.status] ?? task.status} · ${task.description}${dependencies}`,
      );
      if (task.tools.length) this.note(`    Инструменты · ${task.tools.join(', ')}`);
      this.note(
        `    Проверка · ${shorten(task.verification)}${task.evidenceCallId ? ` · ${task.evidenceCallId}` : ''}`,
      );
    }
  }

  stats(stats: SessionStats) {
    if (this.json) return this.printJson(stats);
    this.note(
      `Сессия ${stats.sessionId} · запусков ${stats.runs} · запросов к модели ${stats.requests}`,
    );
    this.note(`Токены · ${usageLine(stats.usage)}`);
    this.note(`Инструменты (${stats.uniqueTools}) · ${counts(stats.tools)}`);
    this.note(`Скиллы (${stats.uniqueSkills}) · ${counts(stats.skills)}`);
    this.note(`MCP · ${counts(stats.mcp)}`);
  }

  diff(changes: FileChange[]) {
    if (this.json) return this.printJson(changes);
    if (!changes.length) this.note('Изменений файлов нет.');
    for (const { path, before, after } of changes) {
      this.note(
        `${path} · ${before?.hash.slice(0, 12) ?? '∅'} → ${after?.hash.slice(0, 12) ?? '∅'}`,
      );
      if (before && after && before.mode !== after.mode)
        this.note(`Режим ${before.mode.toString(8)} → ${after.mode.toString(8)}`);
      for (const line of diffText(path, before?.content ?? null, after?.content ?? null)) {
        const cleaned = terminalText(line);
        const color = line.startsWith('+')
          ? '32'
          : line.startsWith('-')
            ? '31'
            : line.startsWith('@@')
              ? '36'
              : '0';
        console.log(tone(this.color, color, cleaned));
      }
    }
  }

  printJson(value: unknown) {
    console.log(JSON.stringify(value));
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return { invalidArguments: value };
  }
}
