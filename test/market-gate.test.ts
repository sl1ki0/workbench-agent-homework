import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluateUpdate, type UpdateDecision } from '../src/market/gate.js';
import { Market, readMarketConfig } from '../src/market/index.js';
import type { Message, Model, ModelReply } from '../src/types.js';

const name = 'progress-summary';

function call(id: string, name: string, args: Record<string, string>): ModelReply {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    usage: { input: 20, output: 6 },
  };
}

function toolResult(messages: Message[], id: string): string | undefined {
  const message = messages.find((item) => item.role === 'tool' && item.tool_call_id === id);
  return message?.content ?? undefined;
}

function tableRow(cells: Array<string | number>): string {
  return '| ' + cells.join(' | ') + ' |';
}

function summary(content: string, countEveryLesson: boolean): string {
  const { lessons } = JSON.parse(content) as {
    lessons: { id: string; learner: string; status: string; minutes: number | null }[];
  };
  const entries = new Map<string, [number, number]>();
  let totalCount = 0;
  let totalMinutes = 0;
  for (const { learner, status, minutes } of lessons) {
    const current = entries.get(learner) ?? [0, 0];
    if (status === 'completed' || countEveryLesson) {
      current[0] += 1;
      current[1] += minutes ?? 0;
      totalCount += 1;
      totalMinutes += minutes ?? 0;
    }
    entries.set(learner, current);
  }
  return [
    '| Ученик | Завершено | Минуты |',
    '| --- | --- | --- |',
    ...[...entries].map(([learner, totals]) => tableRow([learner, ...totals])),
    tableRow(['Итого', totalCount, totalMinutes]),
    '',
    ...lessons
      .filter(({ status, minutes }) => status === 'completed' && minutes === null)
      .map(({ id }) => 'Продолжительность ' + id + ' отсутствует.'),
    '',
  ].join('\n');
}

const replayModel: Model = {
  async complete(messages) {
    const task = messages.findLast(({ role }) => role === 'user')?.content ?? '';
    const skill = toolResult(messages, 'skill');
    if (toolResult(messages, 'write'))
      return {
        message: { role: 'assistant', content: 'Результат сохранён.' },
        usage: { input: 10, output: 4 },
      };

    if (task.includes('evidence.txt')) {
      const note = toolResult(messages, 'read');
      if (!note) return call('read', 'read_file', { path: 'note.txt' });
      const { output } = JSON.parse(note) as { output: { content: string } };
      return call('write', 'write_file', { path: 'evidence.txt', content: output.content });
    }
    if (task.includes('open-tasks.md') || task.includes('tracker-status.md')) {
      if (!skill) return call('skill', 'load_skill', { name: 'open-task-report' });
      const result = toolResult(messages, 'tracker');
      if (!result) return call('tracker', 'mcp_tracker_list_tasks', { status: 'open' });
      if (task.includes('tracker-status.md')) {
        assert.match(result, /TRACKER_UNAVAILABLE/u);
        return call('write', 'write_file', {
          path: 'tracker-status.md',
          content: 'Учебный трекер временно недоступен.',
        });
      }
      const { output } = JSON.parse(result) as {
        output: { tasks: { id: string; title: string }[] };
      };
      return call('write', 'write_file', {
        path: 'open-tasks.md',
        content: [
          '| ID | Название |',
          '| --- | --- |',
          ...output.tasks.map(({ id, title }) => tableRow([id, title])),
          '',
        ].join('\n'),
      });
    }
    if (!skill) return call('skill', 'load_skill', { name });
    const input = toolResult(messages, 'read');
    if (!input) return call('read', 'read_file', { path: 'progress.json' });
    const { output } = JSON.parse(input) as { output: { content: string } };
    return call('write', 'write_file', {
      path: 'progress-summary.md',
      content: summary(output.content, skill.includes('Count every scheduled entry')),
    });
  },
};

test('update gate runs the full paired suite, accepts a good candidate and records blocked regression', async (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'versions');
  const market = new Market({
    root,
    registries: [{ id: 'demo', index: resolve('market-fixtures/index-stable.json') }],
  });
  const baseline = await market.stage(name, '1.0.0');
  market.activate(name, baseline.version, baseline.digest, null);
  let good: UpdateDecision | undefined;
  const [applied] = await market.reconcile(async (candidate, current) => {
    good = await evaluateUpdate({
      market,
      candidate,
      baseline: current,
      output: join(directory, 'passing'),
      model: replayModel,
    });
    assert.equal(
      market.active()[0]?.version,
      '1.0.0',
      'Evidence alone must not activate a version',
    );
    return good.allowed;
  });
  assert.ok(good, applied?.error);
  assert.equal(applied?.status, 'activated', good.reason);
  assert.equal(market.active()[0]?.version, '1.1.0');
  assert.equal(good.allowed, true, good.reason);
  assert.equal(good.rows.length, 30);
  assert.equal(new Set(good.rows.map(({ run_id }) => run_id)).size, 30);
  assert.equal(new Set(good.rows.map(({ session_id }) => session_id)).size, 30);
  assert.deepEqual(
    good.rows.slice(0, 6).map(({ variant, trial }) => variant + trial),
    ['A1', 'B1', 'A2', 'B2', 'A3', 'B3'],
  );
  assert.ok(
    good.comparison.every(
      ({ baseline, candidate }) => baseline.passed === 3 && candidate.passed === 3,
    ),
  );
  assert.match(
    readFileSync(good.reportFile, 'utf8'),
    /\]\(trials\/open-tasks\/A1\/events.jsonl\)/u,
  );
  assert.ok(good.rows.every(({ journal, artifact }) => journal && artifact));
  const verified = JSON.parse(readFileSync(good.decisionFile, 'utf8')) as { allowed: boolean };
  assert.equal(verified.allowed, true);

  const next = new Market({ root, registries: readMarketConfig('market-fixtures/config.json') });
  let rejected: UpdateDecision | undefined;
  const [blocked] = await next.reconcile(async (candidate, current) => {
    rejected = await evaluateUpdate({
      market: next,
      candidate,
      baseline: current,
      output: join(directory, 'rejected'),
      model: replayModel,
    });
    return rejected.allowed;
  });
  assert.ok(rejected, blocked?.error);
  assert.equal(blocked?.status, 'blocked');
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason, /regression against active version/u);
  assert.ok(
    rejected.rows
      .filter(({ variant, case_id }) => variant === 'B' && case_id.startsWith('progress'))
      .every(
        ({ outcome_pass, routing_pass_or_na }) => !outcome_pass && routing_pass_or_na === true,
      ),
  );
  assert.equal(market.active()[0]?.version, '1.1.0');
  assert.equal(market.rollback(name).version, '1.0.0');
});

test('update gate saves a refusal for a missing baseline and never calls a provider', async (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-gate-uncovered-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const market = new Market({
    root: join(directory, 'versions'),
    registries: readMarketConfig('market-fixtures/config.json'),
  });
  const candidate = await market.stage(name, '1.1.0');
  const result = await evaluateUpdate({
    market,
    candidate,
    baseline: null,
    output: join(directory, 'rejected'),
    model: {
      async complete() {
        throw new Error('Provider was called without a baseline');
      },
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.rows, []);
  assert.match(readFileSync(result.decisionFile, 'utf8'), /No active baseline/u);
  assert.deepEqual(market.activeRoots(), []);
});
