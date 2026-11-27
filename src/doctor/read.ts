import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../types.js';

export function eventObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEvent(value: unknown): AgentEvent | undefined {
  const object = eventObject(value);
  if (
    !object ||
    !['id', 'time', 'session_id', 'run_id', 'type'].every(
      (key) => typeof object[key] === 'string' && object[key].length > 0,
    ) ||
    !eventObject(object.data)
  )
    return undefined;
  return object as unknown as AgentEvent;
}

export function readSessionEvents(stateDir: string, sessionId: string) {
  const events: AgentEvent[] = [];
  const limitations: string[] = [];
  const seen = new Set<string>();
  const eventsDir = join(stateDir, 'events');
  const folder = existsSync(eventsDir) ? eventsDir : stateDir;

  if (!existsSync(folder)) {
    return { events, limitations: [`Каталог журналов отсутствует: ${folder}`] };
  }

  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    for (const [index, line] of readFileSync(join(folder, entry.name), 'utf8')
      .split(/\r?\n/u)
      .entries()) {
      if (!line.trim()) continue;
      let event: AgentEvent | undefined;
      try {
        event = parseEvent(JSON.parse(line));
      } catch {
        /* report the invalid line below */
      }
      const location = `${entry.name}:${index + 1}`;
      if (!event) {
        limitations.push(`Пропущена некорректная строка журнала ${location}`);
      } else if (event.session_id === sessionId) {
        if (seen.has(event.id))
          limitations.push(`Пропущено повторное событие ${event.id} в ${location}`);
        else {
          seen.add(event.id);
          events.push(event);
        }
      }
    }
  }
  return { events, limitations };
}
