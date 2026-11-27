import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Agent } from '../src/runtime/index.js';
import type { Message, ModelReply, ToolDefinition } from '../src/types.js';
import { readPolicy, Workspace } from '../src/workspace/index.js';

type ToolCall = NonNullable<ModelReply['message']['tool_calls']>[number];
type ScriptStep = ModelReply | ((messages: Message[], tools: ToolDefinition[]) => ModelReply);

const originalOrder = readFileSync(join(process.cwd(), 'workspace/order.py'), 'utf8');
const originalTests = readFileSync(join(process.cwd(), 'workspace/test_order.py'), 'utf8');
const correctedOrder = `def calculate_total(prices: list[float], discount_percent: float) -> float:
    if not 0 <= discount_percent <= 100:
        raise ValueError('discount_percent must be between 0 and 100')
    return sum(prices) * (1 - discount_percent / 100)
`;

function tool(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function calls(...toolCalls: ToolCall[]): ModelReply {
  return { message: { role: 'assistant', content: null, tool_calls: toolCalls } };
}

function answer(content = 'Готово'): ModelReply {
  return { message: { role: 'assistant', content } };
}

function transcript(messages: Message[], id: string): string {
  const message = messages.findLast((value) => value.role === 'tool' && value.tool_call_id === id);
  assert.ok(message?.role === 'tool', `Missing tool result for ${id}`);
  return message.content;
}

function scripted(...steps: ScriptStep[]) {
  let next = 0;
  return {
    complete(messages: Message[], tools: ToolDefinition[]): Promise<ModelReply> {
      const step = steps[next++];
      assert.ok(step, `Unexpected model request ${next}`);
      return Promise.resolve(typeof step === 'function' ? step(messages, tools) : step);
    },
    get requests() {
      return next;
    },
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'course-agent-runtime-'));
  const workspaceRoot = join(root, 'workspace');
  const stateDir = join(root, 'state');
  mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, 'order.py'), originalOrder);
  writeFileSync(join(workspaceRoot, 'test_order.py'), originalTests);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = readPolicy(join(process.cwd(), 'config/policy.json'));
  return {
    root: workspaceRoot,
    stateDir,
    workspace: new Workspace(workspaceRoot, policy),
    read: (name: string) => readFileSync(join(workspaceRoot, name), 'utf8'),
    write: (name: string, content: string) => writeFileSync(join(workspaceRoot, name), content),
  };
}

test('corrects the control project through tools, preserves its tests and runs Bash', async (t) => {
  const project = fixture(t);
  const model = scripted(
    (_messages, tools) => {
      assert.ok(tools.every(({ name, description, schema }) => name && description && schema));
      return calls(
        tool('list', 'list_files', { path: '.' }),
        tool('initial', 'read_file', { path: 'order.py' }),
      );
    },
    (messages) => {
      assert.match(transcript(messages, 'list'), /test_order\.py/);
      assert.match(transcript(messages, 'initial'), /sum\(prices\) - discount_percent/);
      return calls(
        tool('invalid', 'read_file', { path: 42 }),
        tool('fix', 'write_file', { path: 'order.py', content: correctedOrder }),
      );
    },
    (messages) => {
      assert.match(transcript(messages, 'invalid'), /error/i);
      assert.match(transcript(messages, 'fix'), /true/);
      return calls(tool('tests', 'Bash', { command: 'python3 -m unittest -v', cwd: '.' }));
    },
    (messages) => {
      assert.match(transcript(messages, 'tests'), /Ran 2 tests/);
      assert.match(transcript(messages, 'tests'), /OK/);
      return answer('Оба теста прошли');
    },
  );
  const agent = new Agent({ ...project, model });
  const run = await agent.start({
    prompt: 'Исправь расчёт итоговой стоимости заказа. Тесты не меняй и запусти их.',
    mode: 'auto',
  });
  assert.equal(run.status, 'completed');
  assert.equal(project.read('order.py'), correctedOrder);
  assert.equal(project.read('test_order.py'), originalTests);
  assert.equal(model.requests, 4);
});

test('safe approval resumes a persisted call using the same run and cumulative budget', async (t) => {
  const project = fixture(t);
  const pending = await new Agent({
    ...project,
    model: scripted(
      calls(tool('fix', 'write_file', { path: 'order.py', content: correctedOrder })),
    ),
  }).start({ prompt: 'Исправь order.py', mode: 'safe', limits: { modelCalls: 2 } });

  assert.equal(pending.status, 'awaiting_confirmation');
  assert.equal(project.read('order.py'), originalOrder);
  assert.equal(pending.spent.modelCalls, 1);
  assert.equal(pending.spent.sideEffects, 0);
  const agent = new Agent({
    ...project,
    model: scripted((messages) => {
      assert.match(transcript(messages, 'fix'), /true/);
      return answer();
    }),
  });
  const approved = await agent.resume(pending.id, 'approve');
  assert.equal(approved.status, 'completed');
  assert.equal(approved.id, pending.id);
  assert.equal(approved.spent.modelCalls, 2);
  assert.equal(approved.spent.toolCalls, 1);
  assert.equal(approved.spent.sideEffects, 1);
  assert.equal(project.read('order.py'), correctedOrder);
});

test('safe denial reaches the model and leaves the project untouched', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(tool('delete', 'delete_file', { path: 'order.py' })),
      (messages) => {
        assert.match(transcript(messages, 'delete'), /declined|denied|отказ/i);
        return calls(tool('read', 'read_file', { path: 'order.py' }));
      },
      (messages) => {
        assert.match(transcript(messages, 'read'), /def calculate_total/);
        return answer('Файл остался на месте');
      },
    ),
  });
  const pending = await agent.start({ prompt: 'Проверь подтверждение', mode: 'safe' });
  assert.equal(pending.status, 'awaiting_confirmation');
  const denied = await agent.resume(pending.id, 'deny');
  assert.equal(denied.status, 'completed');
  assert.equal(denied.spent.sideEffects, 0);
  assert.equal(project.read('order.py'), originalOrder);
});

test('approval revalidates policy after restart before executing the saved call', async (t) => {
  const project = fixture(t);
  const pending = await new Agent({
    ...project,
    model: scripted(
      calls(tool('fix', 'write_file', { path: 'order.py', content: correctedOrder })),
    ),
  }).start({ prompt: 'Исправь order.py', mode: 'safe' });
  assert.equal(pending.status, 'awaiting_confirmation');

  const policy = {
    ...project.workspace.policy,
    files: { readOnly: ['order.py', 'test_order.py'] },
  };
  const restart = new Agent({
    ...project,
    workspace: new Workspace(project.root, policy),
    afterExecute: () => assert.fail('A file denied by current policy reached the executor'),
    model: scripted((messages) => {
      assert.match(transcript(messages, 'fix'), /read-only|policy|политик/i);
      return answer('Правка отклонена текущей политикой');
    }),
  });
  const resumed = await restart.resume(pending.id, 'approve');
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.spent.sideEffects, 0);
  assert.equal(project.read('order.py'), originalOrder);
});

test('a duplicate tool call is reused once and a conflicting duplicate becomes a protocol error', async (t) => {
  const project = fixture(t);
  let writes = 0;
  const original = tool('same-id', 'write_file', { path: 'order.py', content: correctedOrder });
  const agent = new Agent({
    ...project,
    afterExecute: ({ call }) => {
      if (call.function.name === 'write_file') writes++;
    },
    model: scripted(
      calls(original),
      calls(original),
      (messages) => {
        assert.match(transcript(messages, 'same-id'), /true/);
        return calls(
          tool('same-id', 'write_file', { path: 'order.py', content: 'conflicting output' }),
        );
      },
      (messages) => {
        assert.match(transcript(messages, 'same-id'), /error/i);
        return answer();
      },
    ),
  });
  const run = await agent.start({ prompt: 'Исправь order.py', mode: 'auto' });
  assert.equal(run.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(run.spent.sideEffects, 1);
  assert.equal(project.read('order.py'), correctedOrder);
});

test('charges an interrupted action durably and requires explicit attribution before recovery or rollback', async (t) => {
  const project = fixture(t);
  let runId = '';
  const beforeCrash = new Agent({
    ...project,
    afterExecute: ({ run }) => {
      runId = run.id;
      throw new Error('injected crash after write');
    },
    model: scripted(
      calls(tool('fix', 'write_file', { path: 'order.py', content: correctedOrder })),
    ),
  });
  await assert.rejects(
    beforeCrash.start({ prompt: 'Исправь order.py', mode: 'auto' }),
    /injected crash/,
  );
  assert.ok(runId);
  assert.equal(project.read('order.py'), correctedOrder);

  const restarted = new Agent({
    ...project,
    model: scripted((messages) => {
      assert.match(transcript(messages, 'fix'), /error/i);
      return answer('Результат проверен после восстановления');
    }),
  });
  const uncertain = await restarted.resume(runId);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.spent.modelCalls, 1);
  assert.equal(uncertain.spent.toolCalls, 1);
  assert.equal(uncertain.spent.sideEffects, 1);
  assert.ok(uncertain.pending?.changes?.some(({ path }) => path === 'order.py'));
  await assert.rejects(async () => restarted.rollback(runId));
  await assert.rejects(async () => restarted.resume(runId, 'skip'));
  const resolved = await restarted.resume(runId, 'skip', { attributeChanges: true });
  assert.equal(resolved.status, 'completed');
  assert.equal(resolved.id, runId);
  assert.equal(resolved.spent.modelCalls, 2);
  assert.equal(resolved.spent.sideEffects, 1);
  assert.equal(project.read('order.py'), correctedOrder);
  await restarted.rollback(runId);
  assert.equal(project.read('order.py'), originalOrder);
});

test('explicit retry of a safely repeatable action creates a new charged attempt', async (t) => {
  const project = fixture(t);
  let id = '';
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(tool('idempotent', 'write_file', { path: 'order.py', content: originalOrder })),
    ),
    afterExecute: ({ run }) => {
      id = run.id;
      throw new Error('injected fault');
    },
  });
  await assert.rejects(
    agent.start({ prompt: 'Сохрани текущий расчёт', mode: 'auto' }),
    /injected fault/,
  );
  const restarted = new Agent({
    ...project,
    model: scripted((messages) => {
      assert.match(transcript(messages, 'idempotent'), /true/);
      return answer();
    }),
  });
  const uncertain = await restarted.resume(id);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.spent.sideEffects, 1);
  const done = await restarted.resume(id, 'retry');
  assert.equal(done.status, 'completed');
  assert.equal(done.spent.sideEffects, 2);
  assert.equal(done.records.findLast(({ call }) => call.id === 'idempotent')?.attempt, 2);
  assert.equal(project.read('order.py'), originalOrder);
});

test('budget for model requests stops the run at the persisted limit', async (t) => {
  const project = fixture(t);
  const model = scripted(calls(tool('read', 'read_file', { path: 'order.py' })));
  const agent = new Agent({ ...project, model });
  const run = await agent.start({
    prompt: 'Прочитай проект',
    mode: 'auto',
    limits: { modelCalls: 1 },
  });
  assert.equal(run.status, 'budget_exhausted');
  assert.equal(run.spent.modelCalls, 1);
  assert.equal(run.spent.toolCalls, 1);
  assert.equal(model.requests, 1);
});

test('budget for tool calls rejects the whole batch without file effects', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(
        tool('fix', 'write_file', { path: 'order.py', content: correctedOrder }),
        tool('read', 'read_file', { path: 'order.py' }),
      ),
    ),
  });
  const run = await agent.start({
    prompt: 'Исправь и прочитай',
    mode: 'auto',
    limits: { toolCalls: 1 },
  });
  assert.equal(run.status, 'budget_exhausted');
  assert.equal(run.spent.toolCalls, 0);
  assert.equal(project.read('order.py'), originalOrder);
});

test('side-effect budget rejects the whole batch before its first write', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(
        tool('fix', 'write_file', { path: 'order.py', content: correctedOrder }),
        tool('extra', 'write_file', { path: 'extra.txt', content: 'new file' }),
      ),
    ),
  });
  const run = await agent.start({
    prompt: 'Внеси две правки',
    mode: 'auto',
    limits: { sideEffects: 1 },
  });
  assert.equal(run.status, 'budget_exhausted');
  assert.equal(run.spent.sideEffects, 0);
  assert.equal(project.read('order.py'), originalOrder);
  assert.equal(existsSync(join(project.root, 'extra.txt')), false);
});

test('result budget bounds large output and marks the returned tool message as incomplete', async (t) => {
  const project = fixture(t);
  project.write('large.txt', 'Я'.repeat(8192));
  const resultBytes = 160;
  const agent = new Agent({
    ...project,
    model: scripted(calls(tool('large', 'read_file', { path: 'large.txt' })), (messages) => {
      const result = transcript(messages, 'large');
      assert.match(result, /truncat|incomplete|неполн|обрез/i);
      assert.ok(Buffer.byteLength(result, 'utf8') <= resultBytes);
      return calls(tool('excess', 'write_file', { path: 'extra.txt', content: 'new file' }));
    }),
  });
  const run = await agent.start({
    prompt: 'Читай большой файл',
    mode: 'auto',
    limits: { resultBytes },
  });
  assert.equal(run.status, 'budget_exhausted');
  assert.ok(run.spent.resultBytes <= resultBytes);
  assert.equal(existsSync(join(project.root, 'extra.txt')), false);
});

const plan = {
  goal: 'Исправить скидку и проверить тесты',
  steps: [
    {
      id: 'inspect',
      description: 'Определить исходный дефект',
      dependsOn: [],
      tools: ['read_file'],
      verification: 'Прочитать исходный order.py',
    },
    {
      id: 'fix',
      description: 'Исправить order.py',
      dependsOn: ['inspect'],
      tools: ['write_file', 'read_file'],
      verification: 'Прочитать обновлённый order.py',
    },
    {
      id: 'verify',
      description: 'Проверить оба теста заказа',
      dependsOn: ['fix'],
      tools: ['Bash'],
      verification: 'Успешный запуск unittest',
    },
  ],
  risks: ['Случайная правка тестов'],
  assumptions: ['Python 3 доступен'],
  doneCriteria: 'Формула исправлена, оба исходных теста проходят',
};

test('planning blocks effects, approval preserves safe mode, and resumed tasks use persisted evidence', async (t) => {
  const project = fixture(t);
  const unorderedPlan = { ...plan, steps: plan.steps.toReversed() };
  const inspector = new Agent({
    ...project,
    afterExecute: ({ call }) => {
      assert.ok(
        !['write_file', 'Bash'].includes(call.function.name),
        'A planning effect reached the executor',
      );
    },
    model: scripted(
      (_messages, tools) => {
        assert.ok(!tools.some(({ name }) => ['write_file', 'delete_file', 'Bash'].includes(name)));
        return calls(
          tool('early-write', 'write_file', { path: 'order.py', content: correctedOrder }),
          tool('early-bash', 'Bash', { command: 'python3 -m unittest -v', cwd: '.' }),
        );
      },
      (messages) => {
        assert.match(transcript(messages, 'early-write'), /error/i);
        assert.match(transcript(messages, 'early-bash'), /error/i);
        return calls(tool('draft', 'submit_plan', unorderedPlan));
      },
      calls(tool('fabricated', 'complete_task', { evidenceCallId: 'absent' })),
      (messages) => {
        assert.match(transcript(messages, 'fabricated'), /error/i);
        return calls(tool('inspect-source', 'read_file', { path: 'order.py' }));
      },
      calls(tool('done-inspect', 'complete_task', { evidenceCallId: 'inspect-source' })),
      calls(tool('apply-fix', 'write_file', { path: 'order.py', content: correctedOrder })),
    ),
  });
  const approval = await inspector.start({ prompt: plan.goal, mode: 'safe', plan: true });
  assert.equal(approval.status, 'awaiting_plan');
  assert.deepEqual(approval.plan, unorderedPlan);
  assert.equal(approval.spent.sideEffects, 0);
  assert.equal(project.read('order.py'), originalOrder);

  const pendingWrite = await inspector.resume(approval.id, 'approve');
  assert.equal(pendingWrite.status, 'awaiting_confirmation');
  assert.equal(project.read('order.py'), originalOrder);
  assert.equal(
    pendingWrite.tasks.find(({ id }) => id === 'inspect')?.evidenceCallId,
    'inspect-source',
  );

  const restart = new Agent({
    ...project,
    model: scripted(
      (messages) => {
        assert.match(transcript(messages, 'apply-fix'), /true/);
        return calls(tool('inspect-fix', 'read_file', { path: 'order.py' }));
      },
      calls(tool('done-fix', 'complete_task', { evidenceCallId: 'inspect-fix' })),
      calls(tool('verify-tests', 'Bash', { command: 'python3 -m unittest -v', cwd: '.' })),
      (messages) => {
        assert.match(transcript(messages, 'verify-tests'), /Ran 2 tests/);
        return calls(tool('done-verify', 'complete_task', { evidenceCallId: 'verify-tests' }));
      },
      answer('Исправление готово'),
    ),
  });
  const pendingBash = await restart.resume(approval.id, 'approve');
  assert.equal(pendingBash.status, 'awaiting_confirmation');
  assert.equal(pendingBash.spent.sideEffects, 1);
  assert.equal(project.read('order.py'), correctedOrder);
  const done = await restart.resume(approval.id, 'approve');
  assert.equal(done.status, 'completed');
  assert.equal(done.id, approval.id);
  assert.equal(done.spent.sideEffects, 2);
  assert.ok(done.tasks.every(({ status }) => status === 'completed'));
  assert.deepEqual(done.tasks.map(({ id, evidenceCallId }) => [id, evidenceCallId]).sort(), [
    ['fix', 'inspect-fix'],
    ['inspect', 'inspect-source'],
    ['verify', 'verify-tests'],
  ]);
  assert.deepEqual(
    done.records.filter(({ phase }) => phase === 'planning').map(({ taskId }) => taskId),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    done.records
      .filter(({ call }) => ['inspect-source', 'apply-fix', 'verify-tests'].includes(call.id))
      .map(({ call, taskId }) => [call.id, taskId]),
    [
      ['inspect-source', 'inspect'],
      ['apply-fix', 'fix'],
      ['verify-tests', 'verify'],
    ],
  );
  assert.equal(project.read('test_order.py'), originalTests);
});

test('declining a saved plan ends the run before any side effect', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(calls(tool('draft', 'submit_plan', plan))),
  });
  const pending = await agent.start({ prompt: plan.goal, mode: 'auto', plan: true });
  assert.equal(pending.status, 'awaiting_plan');
  const declined = await agent.resume(pending.id, 'deny');
  assert.notEqual(declined.status, 'running');
  assert.notEqual(declined.status, 'awaiting_plan');
  assert.equal(declined.spent.sideEffects, 0);
  assert.equal(project.read('order.py'), originalOrder);
});

test('diff and rollback after restart cover created, modified and deleted files only', async (t) => {
  const project = fixture(t);
  project.write('obsolete.txt', 'obsolete');
  project.write('standalone.txt', 'standalone');
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(
        tool('fix', 'write_file', { path: 'order.py', content: correctedOrder }),
        tool('create', 'write_file', { path: 'generated.txt', content: 'generated' }),
        tool('delete', 'delete_file', { path: 'obsolete.txt' }),
      ),
      answer(),
    ),
  });
  const run = await agent.start({ prompt: 'Обнови исходники', mode: 'auto' });
  assert.equal(run.status, 'completed');
  const restart = new Agent({ ...project, model: scripted() });
  const diff = await restart.diff(run.id);
  assert.deepEqual([...diff].map(({ path }) => path).sort(), [
    'generated.txt',
    'obsolete.txt',
    'order.py',
  ]);
  const modified = diff.find(({ path }) => path === 'order.py');
  assert.ok(modified?.before?.hash && modified.after?.hash);
  assert.notEqual(modified.before.hash, modified.after.hash);
  assert.equal(diff.find(({ path }) => path === 'generated.txt')?.before, null);
  assert.equal(diff.find(({ path }) => path === 'obsolete.txt')?.after, null);
  project.write('standalone.txt', 'external but unrelated');
  await restart.rollback(run.id);
  assert.equal(project.read('order.py'), originalOrder);
  assert.equal(project.read('obsolete.txt'), 'obsolete');
  assert.equal(project.read('standalone.txt'), 'external but unrelated');
  assert.equal(project.read('test_order.py'), originalTests);
  assert.equal(existsSync(join(project.root, 'generated.txt')), false);
});

test('rollback conflict is atomic across all changed files', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(
        tool('first', 'write_file', { path: 'first.txt', content: 'agent change' }),
        tool('fix', 'write_file', { path: 'order.py', content: correctedOrder }),
      ),
      answer(),
    ),
  });
  const run = await agent.start({ prompt: 'Измени оба файла', mode: 'auto' });
  project.write('order.py', 'external change');
  const restart = new Agent({ ...project, model: scripted() });
  await assert.rejects(async () => restart.rollback(run.id), /conflict|конфликт/i);
  assert.equal(project.read('order.py'), 'external change');
  assert.equal(project.read('first.txt'), 'agent change');
});

test('an external change stops the next mutation and leaves the conflicting file intact', async (t) => {
  const project = fixture(t);
  const agent = new Agent({
    ...project,
    model: scripted(
      calls(tool('fix', 'write_file', { path: 'order.py', content: correctedOrder })),
      (messages) => {
        assert.match(transcript(messages, 'fix'), /true/);
        project.write('order.py', 'external change');
        return calls(
          tool('second', 'write_file', { path: 'created.txt', content: 'second change' }),
        );
      },
    ),
  });
  const run = await agent.start({ prompt: 'Внеси две правки', mode: 'auto' });
  assert.notEqual(run.status, 'completed');
  assert.match(run.error ?? '', /conflict|конфликт/i);
  assert.equal(project.read('order.py'), 'external change');
  assert.equal(existsSync(join(project.root, 'created.txt')), false);
});

test('a new run retains the session dialogue and reports partial and missing usage accurately', async (t) => {
  const project = fixture(t);
  const first = await new Agent({
    ...project,
    model: scripted({
      ...answer('Начальная сумма заказа составляет 150'),
      usage: { input: 40, output: 6, cached: 15 },
    }),
  }).start({ prompt: 'Какова сумма заказа до скидки?', mode: 'auto' });

  const restart = new Agent({
    ...project,
    model: scripted((messages) => {
      assert.ok(
        messages.some(
          ({ role, content }) => role === 'user' && content === 'Какова сумма заказа до скидки?',
        ),
      );
      assert.ok(
        messages.some(
          ({ role, content }) =>
            role === 'assistant' && content === 'Начальная сумма заказа составляет 150',
        ),
      );
      return answer('Со скидкой 10% получается 135');
    }),
  });
  const second = await restart.start({
    prompt: 'А со скидкой 10%?',
    sessionId: first.sessionId,
    mode: 'auto',
  });
  assert.equal(second.status, 'completed');
  assert.notEqual(first.id, second.id);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.usage.input.status, 'unknown');
  const stats = await restart.stats(first.sessionId);
  assert.equal(stats.runs, 2);
  assert.equal(stats.usage.input.status, 'partial');
  assert.equal(stats.usage.input.known, 1);
  assert.equal(stats.usage.input.requests, 2);
  assert.equal(stats.usage.input.total, 40);
  assert.equal(stats.usage.cached.total, 15);
  assert.equal(stats.usage.output.total, 6);
  const log = readFileSync(join(project.stateDir, 'events', `${second.id}.jsonl`), 'utf8');
  const events = log
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          time: string;
          type: string;
          data: object;
          session_id: string;
          run_id: string;
        },
    );
  assert.ok(events.length >= 2);
  assert.equal(new Set(events.map(({ id }) => id)).size, events.length);
  assert.ok(
    events.every(
      (event) =>
        event.session_id === first.sessionId &&
        event.run_id === second.id &&
        Number.isFinite(Date.parse(event.time)) &&
        event.type &&
        typeof event.data === 'object',
    ),
  );
});
