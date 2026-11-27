import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, isMissing, withLock } from './files.js';

export interface SourceSchedule {
  pollingEnabled: boolean;
  autoEnabled: boolean;
  intervalMinutes: number;
  nextCheck?: number;
  ownerPid?: number;
  last?: { time: string; status: 'running' | 'completed' | 'failed'; message?: string };
}

type Schedules = Record<string, SourceSchedule>;
interface LegacySchedule {
  enabled: boolean;
  intervalMinutes: number;
  nextCheck?: number;
  last?: SourceSchedule['last'];
}

const defaults: SourceSchedule = { pollingEnabled: false, autoEnabled: false, intervalMinutes: 60 };

export function validInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_080;
}

function readSchedule(root: string): { sources?: Schedules; legacy?: LegacySchedule } {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, 'auto.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Некорректное расписание рынка');
    }
    if (
      'sources' in raw &&
      raw.sources &&
      typeof raw.sources === 'object' &&
      !Array.isArray(raw.sources)
    ) {
      const sources = raw.sources as Schedules;
      for (const value of Object.values(sources)) {
        if (
          !value ||
          typeof value.pollingEnabled !== 'boolean' ||
          typeof value.autoEnabled !== 'boolean' ||
          !validInterval(value.intervalMinutes) ||
          (value.nextCheck !== undefined && !Number.isFinite(value.nextCheck))
        ) {
          throw new Error('Некорректное расписание источника рынка');
        }
      }
      return { sources };
    }
    const saved = raw as LegacySchedule;
    if (
      typeof saved.enabled !== 'boolean' ||
      !validInterval(saved.intervalMinutes) ||
      (saved.nextCheck !== undefined && !Number.isFinite(saved.nextCheck))
    ) {
      throw new Error('Некорректное расписание рынка');
    }
    return { legacy: saved };
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

export function hasScheduledSources(root: string): boolean {
  const schedule = readSchedule(root);
  return Boolean(
    schedule.legacy?.enabled ||
    Object.values(schedule.sources ?? {}).some(({ pollingEnabled }) => pollingEnabled),
  );
}

function ownerIsAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class MarketSchedule {
  constructor(
    private readonly root: string,
    private readonly ids: string[],
  ) {}

  private load(): Schedules {
    const { sources, legacy } = readSchedule(this.root);
    return Object.fromEntries(
      this.ids.map((id) => [
        id,
        (sources && Object.hasOwn(sources, id) ? sources[id] : undefined) ??
          (legacy
            ? {
                pollingEnabled: legacy.enabled,
                autoEnabled: legacy.enabled,
                intervalMinutes: legacy.intervalMinutes,
                nextCheck: legacy.nextCheck,
                last: legacy.last,
              }
            : { ...defaults }),
      ]),
    );
  }

  sources() {
    return Object.entries(this.load()).map(([registry, schedule]) => ({ registry, ...schedule }));
  }

  get(id: string): SourceSchedule {
    this.requireSource(id);
    return this.load()[id]!;
  }

  configure(
    id: string,
    input: Partial<Pick<SourceSchedule, 'pollingEnabled' | 'autoEnabled' | 'intervalMinutes'>>,
  ): void {
    this.requireSource(id);
    this.change((sources) => {
      const old = sources[id]!;
      sources[id] = { ...old, ...input, nextCheck: Date.now() };
    });
  }

  claim(id: string, manual: boolean): boolean {
    const current = this.get(id);
    const canCheck = ({ pollingEnabled, nextCheck, ownerPid }: SourceSchedule) =>
      !ownerIsAlive(ownerPid) && (manual || (pollingEnabled && (nextCheck ?? 0) <= Date.now()));
    if (!canCheck(current)) return false;
    return this.change((sources) => {
      const state = sources[id]!;
      if (!canCheck(state)) return false;
      const now = Date.now();
      sources[id] = {
        ...state,
        ownerPid: process.pid,
        nextCheck: now + state.intervalMinutes * 60_000,
        last: { time: new Date(now).toISOString(), status: 'running' },
      };
      return true;
    });
  }

  finish(id: string, last: NonNullable<SourceSchedule['last']>): void {
    this.change((sources) => {
      const state = sources[id]!;
      if (state.ownerPid === process.pid) sources[id] = { ...state, last, ownerPid: undefined };
    });
  }

  private requireSource(id: string) {
    if (!this.ids.includes(id)) throw new Error(`Неизвестный источник рынка: ${id}`);
  }

  private change<T>(work: (sources: Schedules) => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return withLock(join(this.root, 'auto.lock'), () => {
      const sources = this.load();
      const result = work(sources);
      atomicJson(join(this.root, 'auto.json'), { schema: 2, sources });
      return result;
    });
  }
}
