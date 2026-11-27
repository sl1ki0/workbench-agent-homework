import { checkCopy } from './checks/no-skill.js';
import { checkClosedTasks, checkOpenTasks } from './checks/open-tasks.js';
import { checkAlternateProgress, checkProgress } from './checks/progress.js';
import type { Check } from './checks/markdown.js';

export interface CallExpectation {
  name: string;
  args?: Record<string, string>;
}

export interface EvaluationCase {
  id: string;
  prompt: string;
  source?: string;
  artifact: string;
  expectedSkill: string | null;
  allowedTools: string[];
  requiredCalls: CallExpectation[];
  check(content: Buffer): Check;
}

export const scenarios: EvaluationCase[] = [
  {
    id: 'open-tasks',
    prompt:
      'Составь отчёт по открытым задачам учебного трекера. Сохрани его в open-tasks.md в виде Markdown-таблицы с колонками ID и Название. Упорядочь строки по ID.',
    artifact: 'open-tasks.md',
    expectedSkill: 'open-task-report',
    allowedTools: [
      'list_files',
      'read_file',
      'write_file',
      'mcp_tracker_list_tasks',
      'mcp_tracker_get_task',
    ],
    requiredCalls: [
      { name: 'mcp_tracker_list_tasks' },
      { name: 'write_file', args: { path: 'open-tasks.md' } },
    ],
    check: checkOpenTasks,
  },
  {
    id: 'progress',
    prompt:
      'Сделай короткую Markdown-сводку прогресса по progress.json. Сохрани в progress-summary.md. Приведи таблицу с колонками Ученик, Завершено, Минуты. По каждому ученику посчитай только завершённые занятия и их суммарные минуты. Добавь строку Итого.',
    source: 'progress.json',
    artifact: 'progress-summary.md',
    expectedSkill: 'progress-summary',
    allowedTools: ['list_files', 'read_file', 'write_file'],
    requiredCalls: [
      { name: 'read_file', args: { path: 'progress.json' } },
      { name: 'write_file', args: { path: 'progress-summary.md' } },
    ],
    check: checkProgress,
  },
  {
    id: 'no-skill',
    prompt: 'Скопируй содержимое файла note.txt без изменений в evidence.txt.',
    source: 'note.txt',
    artifact: 'evidence.txt',
    expectedSkill: null,
    allowedTools: ['list_files', 'read_file', 'write_file'],
    requiredCalls: [
      { name: 'read_file', args: { path: 'note.txt' } },
      { name: 'write_file', args: { path: 'evidence.txt' } },
    ],
    check: checkCopy,
  },
];

export const extendedScenarios: EvaluationCase[] = [
  ...scenarios,
  {
    id: 'closed-tasks',
    prompt:
      'Сохрани закрытые задачи учебного трекера в closed-tasks.md. Нужна Markdown-таблица со столбцами ID и Название, отсортированная по ID.',
    artifact: 'closed-tasks.md',
    expectedSkill: null,
    allowedTools: [
      'list_files',
      'read_file',
      'write_file',
      'mcp_tracker_list_tasks',
      'mcp_tracker_get_task',
    ],
    requiredCalls: [
      { name: 'mcp_tracker_list_tasks' },
      { name: 'write_file', args: { path: 'closed-tasks.md' } },
    ],
    check: checkClosedTasks,
  },
  {
    id: 'progress-variant',
    prompt:
      'Собери progress-summary.md по progress.json. Напиши Markdown-таблицу Ученик, Завершено, Минуты. Включи всех учеников, считай только завершённые занятия, последней строкой дай Итого.',
    source: 'progress.json',
    artifact: 'progress-summary.md',
    expectedSkill: 'progress-summary',
    allowedTools: ['list_files', 'read_file', 'write_file'],
    requiredCalls: [
      { name: 'read_file', args: { path: 'progress.json' } },
      { name: 'write_file', args: { path: 'progress-summary.md' } },
    ],
    check: checkAlternateProgress,
  },
];
