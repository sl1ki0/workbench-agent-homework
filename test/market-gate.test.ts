import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateUpdate } from '../src/market/gate.js';
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

function summary(content: string, countEveryLesson: boolean): string {
  const { lessons } = JSON.parse(content) as {
    lessons: { learner: string; status: string; minutes: number }[];
  };
  const entries = new Map<string, [number, number]>();
  let totalCount = 0;
  let totalMinutes = 0;
  for (const { learner, status, minutes } of lessons) {
    const current = entries.get(learner) ?? [0, 0];
    if (status === 'completed' || countEveryLesson) {
      current[0] += 1;
      current[1] += minutes;
      totalCount += 1;
      totalMinutes += minutes;
    }
    entries.set(learner, current);
  }
  const rows = [...entries].map(
    ([learner, [count, minutes]]) => `| ${learner} | ${count} | ${minutes} |`,
  );
  return [
    '| Ученик | Завершено | Минуты |',
    '| --- | --- | --- |',
    ...rows,
    `| Итого | ${totalCount} | ${totalMinutes} |`,
    '',
  ].join('\n');
}

const replayModel: Model = {
  async complete(messages) {
    const skill = toolResult(messages, 'skill');
    if (!skill) return call('skill', 'load_skill', { name });
    const input = toolResult(messages, 'read');
    if (!input) return call('read', 'read_file', { path: 'progress.json' });
    if (!toolResult(messages, 'write')) {
      const { output } = JSON.parse(input) as { output: { content: string } };
      return call('write', 'write_file', {
        path: 'progress-summary.md',
        content: summary(output.content, skill.includes('Count every scheduled entry')),
      });
    }
    return {
      message: { role: 'assistant', content: 'Сводка сохранена.' },
      usage: { input: 10, output: 4 },
    };
  },
};

test('update gate runs paired real tool harness, accepts a good candidate and records blocked regression', async (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const market = new Market({
    root: join(directory, 'versions'),
    registries: readMarketConfig('market-fixtures/config.json'),
  });
  const baseline = await market.stage(name, '1.0.0');
  const candidate = await market.stage(name, '1.1.0');
  market.activate(name, baseline.version, baseline.digest, null);
  const good = await evaluateUpdate({
    market,
    candidate,
    baseline,
    output: join(directory, 'passing'),
    model: replayModel,
  });
  assert.equal(good.allowed, true, good.reason);
  assert.equal(good.rows.length, 4);
  assert.deepEqual(
    good.rows.map(({ case_id, variant, trial_pass }) => [case_id, variant, trial_pass]),
    [
      ['progress', 'A', true],
      ['progress', 'B', true],
      ['progress-variant', 'A', true],
      ['progress-variant', 'B', true],
    ],
  );
  assert.ok(good.rows.every(({ journal, artifact }) => journal && artifact));
  assert.equal(market.active()[0]?.version, '1.0.0', 'Evidence alone must not activate a version');
  const verified = JSON.parse(readFileSync(good.decisionFile, 'utf8')) as { allowed: boolean };
  assert.equal(verified.allowed, true);
  market.activate(name, candidate.version, candidate.digest, baseline);

  const broken = await market.stage(name, '2.0.0');
  const rejected = await evaluateUpdate({
    market,
    candidate: broken,
    baseline: candidate,
    output: join(directory, 'rejected'),
    model: replayModel,
  });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason, /regression against active version/u);
  assert.ok(
    rejected.rows
      .filter(({ variant }) => variant === 'B')
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
