import type { Usage } from '../types.js';
import type { Run, SessionStats, UsageSummary, UsageTotal } from './types.js';

export function summarizeUsage(samples: Usage[], requests: number): UsageSummary {
  function category(key: keyof Usage): UsageTotal {
    const values = samples.map((sample) => sample[key]).filter((value) => value !== undefined);
    const known = values.length;
    return {
      total: known ? values.reduce((sum, value) => sum + value, 0) : null,
      known,
      requests,
      status: !known ? 'unknown' : known === requests ? 'complete' : 'partial',
    };
  }
  return {
    input: category('input'),
    output: category('output'),
    cached: category('cached'),
    reasoning: category('reasoning'),
  };
}

export function summarizeSession(sessionId: string, runs: Run[]): SessionStats {
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();
  const mcp = new Map<string, number>();
  const requests = runs.reduce((sum, run) => sum + run.spent.modelCalls, 0);
  const add = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const run of runs) {
    for (const event of run.events) {
      const { name, server, tool } = event.data;
      if (event.type === 'skill_loaded' && typeof name === 'string') add(skills, name);
      if (event.type === 'tool_call' && typeof name === 'string') add(tools, name);
      if (event.type === 'tool_started' && typeof server === 'string' && typeof tool === 'string') {
        add(mcp, `${server}/${tool}`);
      }
    }
  }
  return {
    sessionId,
    runs: runs.length,
    requests,
    usage: summarizeUsage(
      runs.flatMap((run) => run.usageSamples),
      requests,
    ),
    tools: Object.fromEntries(tools),
    skills: Object.fromEntries(skills),
    mcp: Object.fromEntries(mcp),
    uniqueTools: tools.size,
    uniqueSkills: skills.size,
  };
}
