import { summarizeUsage } from '../runtime/stats.js';
import type { UsageSummary } from '../runtime/types.js';
import type { AgentEvent, Usage } from '../types.js';
import { eventObject, readSessionEvents } from './read.js';
import { diagnosticFindings, type Finding } from './rules.js';

export interface Frequency {
  tools: Record<string, number>;
  skills: Record<string, number>;
  mcp: Record<string, number>;
}

interface RunReport {
  run_id: string;
  status: string;
  events: number;
  requests: number;
  usage: UsageSummary;
  frequency: Frequency;
  findings: Finding[];
  limitations: string[];
}

function numericCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageSample(value: unknown): Usage {
  const raw = eventObject(value);
  const usage: Usage = {};
  for (const key of ['input', 'output', 'cached', 'reasoning'] as const) {
    const count = numericCount(raw?.[key]);
    if (count !== undefined) usage[key] = count;
  }
  return usage;
}

function collectUsage(events: AgentEvent[]) {
  const requests = new Set<number>();
  const byRequest = new Map<number, Usage>();
  const unnumbered: Usage[] = [];
  let unnumberedRequests = 0;
  let reported = 0;

  for (const { type, data } of events) {
    const request = numericCount(data.request);
    if (type === 'model_request') {
      if (request === undefined) unnumberedRequests++;
      else requests.add(request);
    }
    if (type === 'model_usage' && (!data.source || data.source === 'agent')) {
      const sample = usageSample(data.usage);
      if (request === undefined) unnumbered.push(sample);
      else byRequest.set(request, sample);
    }
    if (type === 'run_finished') {
      reported = numericCount(eventObject(data.spent)?.modelCalls) ?? reported;
    }
  }
  const samples = [...byRequest.values(), ...unnumbered];
  const knownRequestIds = new Set([...requests, ...byRequest.keys()]);
  const requestCount = Math.max(
    reported,
    knownRequestIds.size + unnumberedRequests,
    samples.length,
  );
  return { samples, requestCount };
}

function frequencies(events: AgentEvent[]): Frequency {
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();
  const mcp = new Map<string, number>();
  const add = (counts: Map<string, number>, name: string) =>
    counts.set(name, (counts.get(name) ?? 0) + 1);

  for (const { type, data } of events) {
    const { name, server, tool } = data;
    if (type === 'tool_call' && typeof name === 'string') add(tools, name);
    if (type === 'skill_loaded' && typeof name === 'string') add(skills, name);
    if (type === 'tool_started' && typeof server === 'string' && typeof tool === 'string')
      add(mcp, `${server}/${tool}`);
  }
  return {
    tools: Object.fromEntries(tools),
    skills: Object.fromEntries(skills),
    mcp: Object.fromEntries(mcp),
  };
}

function reportRun(
  runId: string,
  events: AgentEvent[],
  usage: UsageSummary,
  requests: number,
): RunReport {
  const finish = events.findLast(({ type }) => type === 'run_finished');
  const limitations: string[] = [];
  if (!events.some(({ type }) => type === 'run_started'))
    limitations.push('В журнале отсутствует начало запуска.');
  if (!finish)
    limitations.push(
      'В журнале отсутствует завершение запуска. Могут быть доступны только промежуточные события.',
    );
  if (requests && (usage.input.status !== 'complete' || usage.output.status !== 'complete')) {
    limitations.push('API usage входных или выходных токенов доступен не для всех запросов.');
  }
  return {
    run_id: runId,
    status: typeof finish?.data.status === 'string' ? finish.data.status : 'unknown',
    events: events.length,
    requests,
    usage,
    frequency: frequencies(events),
    findings: diagnosticFindings(events),
    limitations,
  };
}

export function diagnoseSession(
  sessionId: string,
  allEvents: AgentEvent[],
  limitations: string[] = [],
) {
  const selected = allEvents.filter(({ session_id }) => session_id === sessionId);
  const grouped = new Map<string, AgentEvent[]>();
  for (const event of selected) {
    const run = grouped.get(event.run_id) ?? [];
    run.push(event);
    grouped.set(event.run_id, run);
  }

  const samples: Usage[] = [];
  let requests = 0;
  const runs = [...grouped]
    .sort(([, a], [, b]) => (a[0]?.time ?? '').localeCompare(b[0]?.time ?? ''))
    .map(([runId, events]) => {
      const usage = collectUsage(events);
      requests += usage.requestCount;
      samples.push(...usage.samples);
      return reportRun(
        runId,
        events,
        summarizeUsage(usage.samples, usage.requestCount),
        usage.requestCount,
      );
    });
  return {
    session_id: sessionId,
    agent: {
      requests,
      usage: summarizeUsage(samples, requests),
      frequency: frequencies(selected),
    },
    doctor: { mode: 'rules', requests: 0, input_tokens: 0, output_tokens: 0 },
    runs,
    limitations: runs.length
      ? limitations
      : [...limitations, 'Для этой сессии в журнале нет событий.'],
  };
}

export type DoctorReport = ReturnType<typeof diagnoseSession>;

export function doctorSession(stateDir: string, sessionId: string): DoctorReport {
  const { events, limitations } = readSessionEvents(stateDir, sessionId);
  return diagnoseSession(sessionId, events, limitations);
}
