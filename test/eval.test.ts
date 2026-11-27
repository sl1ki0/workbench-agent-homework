import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scenarios } from '../eval/cases.js';
import { checkCopy } from '../eval/checks/no-skill.js';
import { checkOpenTasks } from '../eval/checks/open-tasks.js';
import { checkProgress } from '../eval/checks/progress.js';
import { writeReport } from '../eval/report.js';
import { executeTrials, type TrialRow } from '../eval/runner.js';
import type { AgentEvent, ModelReply } from '../src/types.js';

const taskTable = `# Открытые задачи

| ID | Название |
| :--- | --- |
| T1 | Подготовить план проекта |
| T3 | Проверить расписание защиты |
| T4 | Собрать отзыв команды |
`;
const progressTable = `| Ученик | Завершено | Минуты |
| --- | --- | ---: |
| Борис | 1 | 25 |
| Анна | 2 | 75 |
| Вера | 0 | 0 |
| **Итого** | 3 | 100 |
`;

test('eval artifact verifiers recognize exact content and reject plausible incorrect variants', () => {
  assert.equal(checkOpenTasks(Buffer.from(taskTable)).pass, true);
  assert.equal(checkOpenTasks(Buffer.from(taskTable.replace('T3', 'T2'))).pass, false);
  assert.equal(checkProgress(Buffer.from(progressTable)).pass, true);
  assert.equal(
    checkProgress(Buffer.from(progressTable.replace('| Вера | 0 | 0 |\n', ''))).pass,
    false,
  );
  assert.equal(
    checkProgress(Buffer.from(progressTable.replace('| 3 | 100 |', '| 3 | 190 |'))).pass,
    false,
  );
  const note = readFileSync(join(process.cwd(), 'eval/fixtures/no-skill/note.txt'));
  assert.equal(checkCopy(note).pass, true);
  assert.equal(checkCopy(note.subarray(0, -1)).pass, false);
});

function call(id: string, name: string, args: Record<string, unknown>): ModelReply {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    usage: { input: 52, output: 8, cached: 12 },
  };
}

test('eval runs an isolated mock attempt with skills, genuine MCP, criteria, JSONL and report', async (t) => {
  const output = mkdtempSync(join(tmpdir(), 'workbench-eval-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const scenario = scenarios.find(({ id }) => id === 'open-tasks');
  assert.ok(scenario);
  let turn = 0;
  await executeTrials(
    output,
    { scenario, variant: 'B' },
    {
      settings: {
        provider: 'compatible',
        endpoint: 'http://unused.invalid/',
        model: 'unit-test-adapter',
        timeoutMs: 1000,
        maxTokens: 250,
        temperature: 0,
      },
      async complete(messages, tools): Promise<ModelReply> {
        turn++;
        assert.ok(tools.some(({ name }) => name === 'mcp_tracker_list_tasks'));
        assert.ok(tools.some(({ name }) => name === 'load_skill'));
        if (turn === 1) return call('skill', 'load_skill', { name: 'open-task-report' });
        if (turn === 2) return call('tracker', 'mcp_tracker_list_tasks', { status: 'open' });
        if (turn === 3) {
          const tracker = messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'tracker',
          );
          assert.match(tracker?.content ?? '', /Подготовить план проекта/u);
          return call('write', 'write_file', { path: 'open-tasks.md', content: taskTable });
        }
        return { message: { role: 'assistant', content: 'Отчёт сохранён.' } };
      },
    },
  );

  writeReport(output);
  const trial = JSON.parse(readFileSync(join(output, 'trials.jsonl'), 'utf8')) as TrialRow;
  assert.ok(trial.trial_pass);
  assert.ok(trial.run_id && trial.artifact && trial.journal);
  assert.equal(trial.routing_pass_or_na, true);
  assert.deepEqual(trial.skill_activations, { 'open-task-report': 1 });
  assert.deepEqual(trial.mcp_calls, { 'tracker/list_tasks': 1 });
  assert.equal(trial.usage?.input.status, 'partial');
  assert.equal(trial.input_tokens, 156);
  assert.equal(readFileSync(join(output, trial.artifact), 'utf8'), taskTable);
  const events = readFileSync(join(output, trial.journal), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AgentEvent);
  assert.ok(
    events.every(
      ({ session_id, run_id }) => session_id === trial.session_id && run_id === trial.run_id,
    ),
  );
  assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /тестовым адаптером/u);
});
