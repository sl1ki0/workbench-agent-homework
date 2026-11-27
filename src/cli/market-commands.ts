import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, isMissing, withLock } from '../market/files.js';
import { evaluateUpdate } from '../market/gate.js';
import {
  Market,
  readMarketConfig,
  type InstalledVersion,
  type ReconcileResult,
  type UpdateGate,
} from '../market/index.js';
import { compareVersions } from '../market/validation.js';
import { makeModel } from '../model/index.js';
import type { Terminal } from './format.js';
import type { CliOptions } from './options.js';

type Input = Record<string, unknown>;
type MarketAction =
  'list' | 'search' | 'install' | 'news' | 'updates' | 'update' | 'rollback' | 'auto';
type MarketOutput = ReconcileResult & { gate?: Awaited<ReturnType<typeof evaluateUpdate>> };
type WatchNotice = (message: string) => void;

interface Schedule {
  enabled: boolean;
  intervalMinutes: number;
  nextCheck?: number;
  last?: { time: string; status: 'running' | 'completed' | 'failed'; message?: string };
}

const defaultSchedule: Schedule = { enabled: false, intervalMinutes: 60 };
const monitorInterval = 15_000;
const batches = new Map<string, Promise<MarketOutput[]>>();

function text(input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Некорректный параметр ${key}`);
  return value.trim();
}

function requiredName(input: Input): string {
  const name = text(input, 'name');
  if (!name) throw new Error('Укажите имя скилла');
  return name;
}

function marketRoot(options: CliOptions): string {
  return join(options.stateDir, 'market');
}

export function openProjectMarket(options: CliOptions): Market {
  return new Market({
    root: marketRoot(options),
    registries: readMarketConfig(options.marketConfig),
  });
}

async function update(options: CliOptions, market: Market, input: Input): Promise<MarketOutput[]> {
  const name = text(input, 'name');
  const version = text(input, 'version');
  const registry = text(input, 'registry');
  const evidence = new Map<string, Awaited<ReturnType<typeof evaluateUpdate>>>();
  let model: ReturnType<typeof makeModel> | undefined;
  const gate: UpdateGate = async (candidate, baseline) => {
    model ??= makeModel();
    const result = await evaluateUpdate({
      market,
      candidate,
      baseline,
      output: join(market.root, 'gates', randomUUID()),
      model,
      skillRoots: options.skillDirs,
    });
    evidence.set(candidate.name, result);
    return result.allowed;
  };

  if (!name) {
    if (version || registry) throw new Error('Версия и реестр требуют имя скилла');
    return (await market.reconcile(gate)).map((result) => ({
      ...result,
      gate: evidence.get(result.update.candidate.name),
    }));
  }

  const current = market.active().find((entry) => entry.name === name);
  if (!current) throw new Error(`Сначала установите базовую версию ${name}`);
  if (registry && registry !== current.registry) {
    throw new Error(`Обновление должно использовать исходный реестр ${current.registry}`);
  }
  const candidate = (await market.search(name)).find(
    (release) =>
      release.name === name &&
      release.registry === current.registry &&
      (!version || release.version === version) &&
      compareVersions(release.version, current.version) > 0,
  );
  if (!candidate) return [];
  const change = { current, candidate };
  let staged: InstalledVersion | undefined;
  try {
    staged = await market.stage(name, candidate.version, candidate.registry);
    if (staged.digest !== candidate.digest)
      throw new Error('Реестр изменил артефакт после проверки');
    if (!(await gate(staged, current))) {
      return [{ update: change, staged, status: 'blocked', gate: evidence.get(name) }];
    }
    market.activate(name, staged.version, staged.digest, current);
    return [{ update: change, staged, status: 'activated', gate: evidence.get(name) }];
  } catch (error) {
    return [
      {
        update: change,
        staged,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        gate: evidence.get(name),
      },
    ];
  }
}

function readSchedule(root: string): Schedule {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, 'auto.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Некорректное расписание рынка');
    const saved = raw as Schedule;
    if (
      typeof saved.enabled !== 'boolean' ||
      !validInterval(saved.intervalMinutes) ||
      (saved.nextCheck !== undefined && !Number.isFinite(saved.nextCheck))
    ) {
      throw new Error('Некорректное расписание рынка');
    }
    return saved;
  } catch (error) {
    if (isMissing(error)) return { ...defaultSchedule };
    throw error;
  }
}

function validInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10_080;
}

function changeSchedule<T>(
  root: string,
  work: (previous: Schedule) => {
    next?: Schedule;
    result: T;
  },
): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return withLock(join(root, 'auto.lock'), () => {
    const { next, result } = work(readSchedule(root));
    if (next) atomicJson(join(root, 'auto.json'), next);
    return result;
  });
}

function checkScheduled(options: CliOptions, manual: boolean): Promise<MarketOutput[]> {
  const root = marketRoot(options);
  const existing = batches.get(root);
  if (existing) return existing;
  const stored = readSchedule(root);
  if (!manual && (!stored.enabled || (stored.nextCheck ?? 0) > Date.now())) {
    return Promise.resolve([]);
  }
  const claim = changeSchedule(root, (state) => {
    const now = Date.now();
    if (!manual && (!state.enabled || (state.nextCheck ?? 0) > now)) return { result: false };
    return {
      next: {
        ...state,
        nextCheck: now + state.intervalMinutes * 60_000,
        last: { time: new Date(now).toISOString(), status: 'running' },
      },
      result: true,
    };
  });
  if (!claim) return Promise.resolve([]);
  const batch = Promise.resolve().then(async () => {
    try {
      const results = await update(options, openProjectMarket(options), {});
      changeSchedule(root, (state) => ({
        next: {
          ...state,
          last: {
            time: new Date().toISOString(),
            status: 'completed',
            message: summarizeUpdates(results),
          },
        },
        result: undefined,
      }));
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      changeSchedule(root, (state) => ({
        next: { ...state, last: { time: new Date().toISOString(), status: 'failed', message } },
        result: undefined,
      }));
      throw error;
    } finally {
      batches.delete(root);
    }
  });
  batches.set(root, batch);
  return batch;
}

function summarizeUpdates(results: MarketOutput[]): string {
  if (!results.length) return 'Новых версий нет';
  return results
    .map(({ update: { candidate }, status, gate, error }) => {
      const details = error ?? gate?.reason;
      const path = gate?.decisionFile;
      return `${candidate.name}@${candidate.version} · ${status}${details ? ` · ${details}` : ''}${path ? `\n  ${path}` : ''}`;
    })
    .join('\n');
}

export function startMarketWatcher(
  options: CliOptions,
  notify: WatchNotice = () => {},
  keepAlive = false,
): () => void {
  let live = true;
  let running = false;
  const tick = async () => {
    if (!live || running) return;
    running = true;
    try {
      const results = await checkScheduled(options, false);
      if (live && results.length) notify(summarizeUpdates(results));
    } catch (error) {
      if (live) notify(error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), monitorInterval);
  if (!keepAlive) timer.unref();
  void tick();
  return () => {
    live = false;
    clearInterval(timer);
  };
}

export function marketOperations(
  options: CliOptions,
): Record<MarketAction, (input: Input) => unknown> {
  const market = () => openProjectMarket(options);
  return {
    list: () => market().list(),
    search(input) {
      if (input.query !== undefined && typeof input.query !== 'string') {
        throw new Error('Строка поиска должна быть текстом');
      }
      return market().search(input.query);
    },
    news: () => market().news(),
    updates: () => market().updates(),
    async install(input) {
      const name = requiredName(input);
      const store = market();
      if (store.active().some((entry) => entry.name === name)) {
        throw new Error(`Скилл ${name} уже активен. Для новой версии используйте update.`);
      }
      const staged = await store.stage(name, text(input, 'version'), text(input, 'registry'));
      return store.activate(name, staged.version, staged.digest, null);
    },
    update: (input) => update(options, market(), input),
    rollback: (input) => market().rollback(requiredName(input)),
    auto(input) {
      const action = text(input, 'action') ?? 'status';
      const root = marketRoot(options);
      if (action === 'status') return readSchedule(root);
      if (action === 'run') return checkScheduled(options, true);
      if (action !== 'on' && action !== 'off')
        throw new Error('Используйте auto on|off|status|run');
      const interval = input.intervalMinutes;
      if (interval !== undefined && !validInterval(interval)) {
        throw new Error('Интервал должен быть целым числом от 1 до 10080 минут');
      }
      return changeSchedule(root, (saved) => {
        const next = {
          ...saved,
          enabled: action === 'on',
          intervalMinutes: (interval as number | undefined) ?? saved.intervalMinutes,
          nextCheck: action === 'on' ? Date.now() : undefined,
        };
        return { next, result: next };
      });
    },
  };
}

function namedInput(value: string | undefined, registry: string | undefined): Input {
  const [name, version, ...invalid] = value?.split('@') ?? [];
  if (invalid.length || (value?.includes('@') && !version)) {
    throw new Error('Используйте имя или имя@версия');
  }
  return { name, version, registry };
}

export async function runMarketCommand(
  args: string[],
  options: CliOptions,
  terminal: Terminal,
): Promise<number> {
  const operations = marketOperations(options);
  const [action = 'list', first, second, ...rest] = args;
  if (action === 'watch') {
    if (first) throw new Error('Используйте market watch');
    terminal.note('Проверки рынка активны по расписанию · Ctrl+C для выхода');
    await new Promise<void>((done) => {
      const stop = startMarketWatcher(options, (message) => terminal.note(message), true);
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const finish = () => {
        stop();
        for (const signal of signals) process.removeListener(signal, finish);
        done();
      };
      for (const signal of signals) process.once(signal, finish);
    });
    return 0;
  }
  if (!Object.hasOwn(operations, action)) {
    throw new Error(
      'Маркет · list | search | install | news | updates | update | rollback | auto | watch',
    );
  }
  if (action !== 'search' && rest.length)
    throw new Error('Слишком много аргументов команды market');
  const kind = action as MarketAction;
  const input =
    kind === 'search'
      ? { query: args.slice(1).join(' ').trim() || undefined }
      : kind === 'auto'
        ? { action: first, intervalMinutes: second === undefined ? undefined : Number(second) }
        : namedInput(first, second);
  const result = await operations[kind](input);
  if (terminal.json) terminal.printJson(result);
  else if (kind === 'update' || (kind === 'auto' && first === 'run')) {
    terminal.note(summarizeUpdates(result as MarketOutput[]));
  } else {
    terminal.note(JSON.stringify(result, null, 2));
  }
  return 0;
}
