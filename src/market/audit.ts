import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMissing, withLock } from './files.js';
import { readRegular } from './registry.js';
import type { InstalledVersion, Release } from './types.js';
import { compareVersions } from './validation.js';

interface Revision {
  name: string;
  version: string;
  digest: string;
}

export interface MarketEvent {
  id: string;
  time: string;
  type: string;
  registry: string;
  old?: Revision;
  next?: Revision;
  result?: string;
  error?: string;
  count?: number;
  run_id?: string;
  session_id?: string;
}

export interface RegistryCheck {
  registry: string;
  count: number;
  newSkills: Release[];
  newVersions: { old: Revision; next: Release }[];
  error?: string;
  reportError?: boolean;
}

type EventData = Omit<MarketEvent, 'id' | 'time'>;
const maxAuditBytes = 16 * 1024 * 1024;

function revision(release: Revision): Revision {
  return { name: release.name, version: release.version, digest: release.digest };
}

export class MarketAudit {
  private readonly log: string;
  private readonly lock: string;

  constructor(root: string) {
    this.log = join(root, 'market-events.jsonl');
    this.lock = join(root, '.audit.lock');
  }

  read(): MarketEvent[] {
    try {
      const data = readRegular(this.log, maxAuditBytes).toString('utf8');
      return data
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MarketEvent);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  record(event: EventData) {
    return withLock(this.lock, () => this.append([event])[0]!);
  }

  claimInstallation(
    registry: string,
    next: Revision,
    context: { runId: string; sessionId: string },
  ): void {
    withLock(this.lock, () => {
      if (
        this.read().some(
          (event) => event.type === 'market_install_claimed' && event.run_id === context.runId,
        )
      ) {
        throw new Error('Install at most one marketplace skill per run');
      }
      this.append([
        {
          type: 'market_install_claimed',
          registry,
          next,
          result: 'started',
          run_id: context.runId,
          session_id: context.sessionId,
        },
      ]);
    });
  }

  private append(rows: EventData[]) {
    const time = new Date().toISOString();
    const events = rows.map((event) => ({ ...event, id: randomUUID(), time }));
    const file = openSync(
      this.log,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const status = fstatSync(file);
      const data = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        status.size + Buffer.byteLength(data) > maxAuditBytes
      ) {
        throw new Error('Invalid marketplace journal or its size limit has been reached');
      }
      writeFileSync(file, data);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return events;
  }

  failed(registry: string, error: string): RegistryCheck {
    return withLock(this.lock, () => {
      const last = this.read().findLast(
        (entry) => entry.type === 'market_scan' && entry.registry === registry,
      );
      this.append([{ type: 'market_scan', registry, result: 'failed', error }]);
      return {
        registry,
        count: 0,
        newSkills: [],
        newVersions: [],
        error,
        reportError: last?.error !== error,
      };
    });
  }

  observe(registry: string, releases: Release[], active: InstalledVersion[]): RegistryCheck {
    return withLock(this.lock, () => {
      const history = this.read().filter((event) => event.registry === registry);
      const existing = new Map(active.map((entry) => [entry.name, entry]));
      const latest = new Map<string, Release>();
      for (const release of releases) {
        const previous = latest.get(release.name);
        if (!previous || compareVersions(release.version, previous.version) > 0) {
          latest.set(release.name, release);
        }
      }
      const newSkills: Release[] = [];
      const newVersions: RegistryCheck['newVersions'] = [];
      const rows: EventData[] = [
        { type: 'market_scan', registry, result: 'ok', count: releases.length },
      ];
      for (const release of latest.values()) {
        const installed = existing.get(release.name);
        const next = revision(release);
        if (!installed) {
          if (
            history.some(
              (row) => row.type === 'market_skill_discovered' && row.next?.name === next.name,
            )
          )
            continue;
          newSkills.push(release);
          rows.push({ type: 'market_skill_discovered', registry, next });
        } else if (compareVersions(release.version, installed.version) > 0) {
          const notified = history.some(
            (row) =>
              row.type === 'market_version_discovered' &&
              row.old?.digest === installed.digest &&
              row.next?.digest === next.digest,
          );
          if (notified) continue;
          const old = revision(installed);
          newVersions.push({ old, next: release });
          rows.push({ type: 'market_version_discovered', registry, old, next });
        }
      }
      this.append(rows);
      return { registry, count: releases.length, newSkills, newVersions };
    });
  }
}
