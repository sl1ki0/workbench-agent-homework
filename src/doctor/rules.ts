import { posix } from 'node:path';
import type { AgentEvent } from '../types.js';
import { eventObject } from './read.js';

export interface Finding {
  type: 'repeated_error' | 'repeated_read';
  run_id: string;
  event_ids: string[];
  counts: Record<string, number>;
  interpretation: string;
  suggestion: string;
}

interface ErroneousAttempt {
  callId: string;
  eventId: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = eventObject(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function errorFindings(events: AgentEvent[]): Finding[] {
  const deniedCalls = new Set(
    events
      .filter(({ type, data }) => type === 'confirmation_decision' && data.decision === 'deny')
      .map(({ data }) => data.call_id),
  );
  const groups = new Map<string, Map<string, ErroneousAttempt[]>>();
  const findings: Finding[] = [];

  function flush(
    name: string,
    messages: Map<string, ErroneousAttempt[]> | undefined,
    runId: string,
  ) {
    for (const [error, attempts] of messages ?? []) {
      if (attempts.length < 2) continue;
      findings.push({
        type: 'repeated_error',
        run_id: runId,
        event_ids: attempts.map(({ eventId }) => eventId),
        counts: { failed_calls: attempts.length },
        interpretation: `${name} несколько раз вернул ту же ошибку с одинаковыми аргументами: ${error}`,
        suggestion:
          'После первой ошибки проверьте параметры и условия вызова. Повторяйте его при появлении новых данных или признаках временного сбоя.',
      });
    }
  }

  const runId = events[0]?.run_id ?? '';
  const names = new Map<string, string>();
  for (const { type, data, id } of events) {
    const { name, args, call_id: callId, error, result } = data;
    if (typeof name !== 'string' || typeof callId !== 'string' || !eventObject(args)) continue;
    const signature = canonical([name, args]);
    if (type === 'tool_result' && eventObject(result)?.ok === true) {
      flush(name, groups.get(signature), runId);
      groups.delete(signature);
    }
    if (type !== 'tool_error' || typeof error !== 'string' || !error || deniedCalls.has(callId))
      continue;
    const byError = groups.get(signature) ?? new Map<string, ErroneousAttempt[]>();
    const attempts = byError.get(error) ?? [];
    if (attempts.every((entry) => entry.callId !== callId)) attempts.push({ callId, eventId: id });
    byError.set(error, attempts);
    groups.set(signature, byError);
    names.set(signature, name);
  }
  for (const [signature, byError] of groups) flush(names.get(signature) ?? '', byError, runId);
  return findings;
}

interface ReadSeries {
  content: string;
  calls: Map<string, string>;
}

function readFindings(events: AgentEvent[]): Finding[] {
  const open = new Map<string, ReadSeries>();
  const observedCalls = new Set<string>();
  const findings: Finding[] = [];
  const runId = events[0]?.run_id ?? '';

  function close(path: string) {
    const previous = open.get(path);
    if (!previous) return;
    open.delete(path);
    if (previous.calls.size < 2) return;
    findings.push({
      type: 'repeated_read',
      run_id: runId,
      event_ids: [...previous.calls.values()],
      counts: { identical_reads: previous.calls.size, observed_intermediate_changes: 0 },
      interpretation: `Полные чтения ${path} вернули одинаковый текст. Между ними журнал не зафиксировал изменения этого файла.`,
      suggestion:
        'Если задача допускает повторное использование данных, сохраните первый результат в контексте. При проверке свежести оставьте повторное чтение.',
    });
  }

  for (const { type, data, id } of events) {
    if (type === 'workspace_changed') {
      const files = Array.isArray(data.files) ? data.files : [];
      for (const file of files) {
        const path = eventObject(file)?.path;
        if (typeof path === 'string') close(posix.normalize(path));
      }
      continue;
    }
    if (type !== 'tool_result' || data.name !== 'read_file' || typeof data.call_id !== 'string')
      continue;
    const result = eventObject(data.result);
    const output = eventObject(result?.output);
    if (
      result?.ok !== true ||
      result.truncated === true ||
      typeof output?.path !== 'string' ||
      typeof output.content !== 'string'
    )
      continue;
    if (observedCalls.has(data.call_id)) continue;
    observedCalls.add(data.call_id);

    const path = posix.normalize(output.path);
    if (open.get(path)?.content !== output.content) {
      close(path);
      open.set(path, { content: output.content, calls: new Map() });
    }
    const series = open.get(path);
    if (series && !series.calls.has(data.call_id)) series.calls.set(data.call_id, id);
  }
  for (const path of open.keys()) close(path);
  return findings;
}

export function diagnosticFindings(events: AgentEvent[]): Finding[] {
  return [...errorFindings(events), ...readFindings(events)];
}
