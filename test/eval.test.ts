import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extendedScenarios, scenarios } from '../eval/cases.js';
import { checkMcpFailure } from '../eval/checks/mcp-failure.js';
import { checkCopy } from '../eval/checks/no-skill.js';
import { checkOpenTasks } from '../eval/checks/open-tasks.js';
import { checkAlternateProgress, checkProgress } from '../eval/checks/progress.js';
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

test('additional evaluation scenarios check missing duration and reject invented tracker records', () => {
  assert.equal(extendedScenarios.length, 5);
  assert.equal(checkMcpFailure(Buffer.from('Трекер временно недоступен.')).pass, true);
  assert.equal(checkMcpFailure(Buffer.from('Трекер недоступен. Известна задача T1.')).pass, false);
  const second = progressTable
    .replace('| 1 | 25 |', '| 2 | 14 |')
    .replace('| 2 | 75 |', '| 1 | 26 |')
    .replace('| 3 | 100 |', '| 3 | 40 |');
  assert.equal(
    checkAlternateProgress(Buffer.from(second + '\nПродолжительность L5 отсутствует.')).pass,
    true,
  );
  assert.equal(checkAlternateProgress(Buffer.from(second)).pass, false);
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

const adapterSettings = {
  provider: 'compatible' as const,
  endpoint: 'http://unused.invalid/',
  model: 'unit-test-adapter',
  timeoutMs: 1000,
  maxTokens: 250,
  temperature: 0,
};

test('isolated MCP sends a real tool failure and the eval verifies acknowledgement', async (t) => {
  const output = mkdtempSync(join(tmpdir(), 'workbench-eval-fault-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const scenario = extendedScenarios.find(({ id }) => id === 'mcp-failure');
  assert.ok(scenario);
  let turn = 0;
  await executeTrials(
    output,
    { scenario, variant: 'B' },
    {
      settings: adapterSettings,
      async complete(messages) {
        turn++;
        if (turn === 1) return call('skill', 'load_skill', { name: 'open-task-report' });
        if (turn === 2) return call('fault', 'mcp_tracker_list_tasks', { status: 'open' });
        if (turn === 3) {
          const reply = messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === 'fault',
          );
          assert.match(reply?.content ?? '', /TRACKER_UNAVAILABLE/u);
          return call('fallback', 'write_file', {
            path: 'tracker-status.md',
            content: 'Учебный трекер временно недоступен.',
          });
        }
        return { message: { role: 'assistant', content: 'Источник недоступен.' } };
      },
    },
    { onTrial: () => {} },
  );
  const row = JSON.parse(readFileSync(join(output, 'trials.jsonl'), 'utf8')) as TrialRow;
  assert.equal(row.trial_pass, true);
  assert.ok(row.journal);
  const journal = readFileSync(join(output, row.journal), 'utf8');
  assert.match(journal, /"type":"tool_error"/u);
  assert.match(journal, /TRACKER_UNAVAILABLE/u);
});

test('resume reconstructs a truncated index and never reruns a committed trial', async (t) => {
  const output = mkdtempSync(join(tmpdir(), 'workbench-eval-resume-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const copy = scenarios.find(({ id }) => id === 'no-skill');
  assert.ok(copy);
  const original = readFileSync(join(process.cwd(), 'eval/fixtures/no-skill/note.txt'), 'utf8');
  let requests = 0;
  const model: Parameters<typeof executeTrials>[2] = {
    settings: adapterSettings,
    async complete(messages) {
      requests++;
      const tools = messages.filter(({ role }) => role === 'tool');
      if (!tools.length) return call('read', 'read_file', { path: 'note.txt' });
      if (tools.length === 1)
        return call('write', 'write_file', { path: 'evidence.txt', content: original });
      return { message: { role: 'assistant', content: 'Скопировано.' } };
    },
  };
  await assert.rejects(
    executeTrials(output, undefined, model, {
      suite: [copy],
      onTrial() {
        throw new Error('simulated shutdown after commit');
      },
    }),
    /simulated shutdown/u,
  );
  const index = join(output, 'trials.jsonl');
  const first = JSON.parse(readFileSync(index, 'utf8')) as TrialRow;
  appendFileSync(index, '{"partial":');
  assert.equal(requests, 3);
  await executeTrials(output, undefined, model, { resume: true, suite: [copy], onTrial: () => {} });
  const rows = readFileSync(index, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TrialRow);
  assert.equal(requests, 18);
  assert.equal(rows.length, 6);
  assert.equal(rows[0]?.run_id, first.run_id);
  assert.equal(new Set(rows.map((row) => row.session_id)).size, 6);
  assert.ok(rows.every((row) => row.trial_pass));
});
