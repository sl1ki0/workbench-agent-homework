import type { AgentEvent } from '../src/types.js';
import type { CallRecord } from '../src/runtime/index.js';
import type { CallExpectation, EvaluationCase } from './cases.js';
import type { Check } from './checks/markdown.js';

export type Variant = 'A' | 'B';

export function checkRouting(
  scenario: EvaluationCase,
  variant: Variant,
  events: AgentEvent[],
): Check | 'n/a' {
  if (variant === 'A') return 'n/a';
  const expected = scenario.expectedSkill ? [scenario.expectedSkill] : [];
  const activated = events.flatMap(({ type, data }) =>
    type === 'skill_loaded' && typeof data.name === 'string' ? [data.name] : [],
  );
  const attempted = events.flatMap(({ type, data }) => {
    if (type !== 'tool_call' || data.name !== 'load_skill' || typeof data.arguments !== 'string')
      return [];
    try {
      const args = JSON.parse(data.arguments) as { name?: unknown } | null;
      return [typeof args?.name === 'string' ? args.name : '(неизвестный скилл)'];
    } catch {
      return ['(некорректные аргументы)'];
    }
  });
  const requiredLoaded = expected.every((name) => activated.includes(name));
  const noOthers = [...activated, ...attempted].every((name) => expected.includes(name));
  return {
    pass: requiredLoaded && noOthers,
    details: [
      `Ожидались ${JSON.stringify(expected)}.`,
      `Попытки ${JSON.stringify(attempted)}; загрузки ${JSON.stringify(activated)}.`,
    ],
  };
}

function matches(record: CallRecord, expected: CallExpectation): boolean {
  return (
    record.call.function.name === expected.name &&
    (expected.errorIncludes
      ? !record.result.ok && (record.result.error ?? '').includes(expected.errorIncludes)
      : record.result.ok) &&
    !record.result.truncated &&
    !record.replayed &&
    Object.entries(expected.args ?? {}).every(([key, value]) => record.args?.[key] === value)
  );
}

export function checkTools(
  scenario: EvaluationCase,
  events: AgentEvent[],
  records: CallRecord[],
): Check {
  const unexpected = [
    ...new Set(
      events.flatMap(({ type, data }) =>
        type === 'tool_call' &&
        typeof data.name === 'string' &&
        data.name !== 'load_skill' &&
        !scenario.allowedTools.includes(data.name)
          ? [data.name]
          : [],
      ),
    ),
  ];
  const details: string[] = [];
  if (unexpected.length) details.push(`Вне правил сценария вызваны ${unexpected.join(', ')}.`);
  let previous = -1;
  let missing = false;
  for (const expected of scenario.requiredCalls) {
    const index = records.findIndex((record, i) => i > previous && matches(record, expected));
    if (index < 0) {
      details.push(
        `Не найден обязательный ${expected.errorIncludes ? 'вызов с ожидаемой ошибкой' : 'успешный вызов'} в нужном порядке: ${expected.name} ${JSON.stringify(expected.args ?? {})}.`,
      );
      missing = true;
    } else {
      const callId = records[index]?.call.id;
      details.push(`${expected.name} подтверждён результатом ${callId}.`);
      previous = index;
    }
  }
  return { pass: !missing && unexpected.length === 0, details };
}
