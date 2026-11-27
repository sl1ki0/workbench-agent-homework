import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnoseSession, doctorSession } from '../src/doctor/index.js';
import type { AgentEvent } from '../src/types.js';

function event(id: string, type: string, data: AgentEvent['data'] = {}, runId = 'r1'): AgentEvent {
  return { id, time: '2026-11-27T15:00:00.000Z', session_id: 's1', run_id: runId, type, data };
}

function read(id: string, content: string, truncated = false): AgentEvent {
  return event(id, 'tool_result', {
    name: 'read_file',
    call_id: `call-${id}`,
    args: { path: 'notes.md' },
    result: { ok: true, truncated, output: { path: 'notes.md', content } },
  });
}

function fail(id: string, args: Record<string, unknown> = { path: 'missing.md' }): AgentEvent {
  return event(id, 'tool_error', {
    name: 'read_file',
    call_id: `call-${id}`,
    args,
    error: 'File missing',
  });
}

test('doctor reports repeated errors and unchanged reads with their event IDs and API usage', () => {
  const report = diagnoseSession('s1', [
    event('start', 'run_started'),
    event('m1', 'model_request', { request: 1 }),
    event('u1', 'model_usage', {
      request: 1,
      usage: { input: 20, output: 8, cached: 10, reasoning: 3 },
      source: 'agent',
    }),
    event('m2', 'model_request', { request: 2 }),
    event('u2', 'model_usage', { request: 2, usage: { output: 4 }, source: 'agent' }),
    event('s', 'skill_loaded', { name: 'summarize' }),
    event('mc', 'tool_call', {
      name: 'mcp_tracker_list_tasks',
      server: 'tracker',
      tool: 'list_tasks',
    }),
    event('me', 'tool_started', {
      name: 'mcp_tracker_list_tasks',
      server: 'tracker',
      tool: 'list_tasks',
    }),
    fail('failed-1'),
    fail('failed-2'),
    read('read-1', 'same'),
    read('read-2', 'same'),
    event('finish', 'run_finished', { status: 'completed', spent: { modelCalls: 2 } }),
    { ...event('other-session', 'run_started'), session_id: 's2' },
  ]);

  assert.equal(report.runs.length, 1);
  assert.deepEqual(
    report.runs[0]?.findings.map(({ type, run_id, event_ids, counts }) => ({
      type,
      run_id,
      event_ids,
      counts,
    })),
    [
      {
        type: 'repeated_error',
        run_id: 'r1',
        event_ids: ['failed-1', 'failed-2'],
        counts: { failed_calls: 2 },
      },
      {
        type: 'repeated_read',
        run_id: 'r1',
        event_ids: ['read-1', 'read-2'],
        counts: { identical_reads: 2, observed_intermediate_changes: 0 },
      },
    ],
  );
  assert.equal(report.agent.usage.input.status, 'partial');
  assert.equal(report.agent.usage.input.total, 20);
  assert.equal(report.agent.usage.cached.total, 10);
  assert.equal(report.agent.usage.output.total, 12);
  assert.deepEqual(report.agent.frequency.skills, { summarize: 1 });
  assert.deepEqual(report.agent.frequency.mcp, { 'tracker/list_tasks': 1 });
  assert.deepEqual(report.doctor, {
    mode: 'rules',
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
  });
});

test('doctor accepts changed files, different failing parameters, and an incomplete read', () => {
  const report = diagnoseSession('s1', [
    event('start', 'run_started'),
    fail('failed-1'),
    fail('failed-2', { path: 'other.md' }),
    read('r1', 'same'),
    event('write', 'workspace_changed', { files: [{ path: 'notes.md', before: 'a', after: 'b' }] }),
    read('r2', 'same'),
    read('r3', 'same', true),
    event('finish', 'run_finished', { status: 'completed' }),
  ]);
  assert.deepEqual(report.runs[0]?.findings, []);
  assert.deepEqual(report.runs[0]?.limitations, []);
});

test('doctor reads saved JSONL and marks malformed records and absent usage', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'doctor-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'events'));
  const valid = JSON.stringify(event('request', 'model_request', { request: 1 }));
  writeFileSync(join(folder, 'events', 'r1.jsonl'), `${valid}\n{broken}\n${valid}\n`);
  const report = doctorSession(folder, 's1');

  assert.equal(report.agent.usage.input.status, 'unknown');
  assert.equal(report.agent.requests, 1);
  assert.equal(report.runs[0]?.events, 1);
  assert.equal(report.runs[0]?.limitations.length, 3);
  assert.equal(report.limitations.length, 2);
});
