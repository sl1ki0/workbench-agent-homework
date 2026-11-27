import { MarketAudit, type RegistryCheck } from './audit.js';
import { download, normalizeRegistries, readIndex } from './registry.js';
import { MarketStore, type VersionReference } from './store.js';
import type {
  AvailableUpdate,
  InstalledVersion,
  MarketOptions,
  ReconcileResult,
  RegistrySource,
  Release,
  UpdateGate,
} from './types.js';
import { compareVersions, safeName, safeVersion } from './validation.js';

export type { MarketEvent, RegistryCheck } from './audit.js';
export { readMarketConfig } from './registry.js';
export type { VersionReference } from './store.js';
export type * from './types.js';

function byVersion(left: Release, right: Release): number {
  return compareVersions(right.version, left.version);
}

function hasQuery(release: Release, query: string): boolean {
  return `${release.name} ${release.description} ${release.notes} ${release.registry}`
    .toLocaleLowerCase()
    .includes(query);
}

export class Market {
  private readonly store: MarketStore;
  private readonly audit: MarketAudit;
  private readonly sources: RegistrySource[];
  private readonly fetcher: typeof fetch;

  constructor(options: MarketOptions) {
    this.sources = normalizeRegistries(options.registries);
    this.store = new MarketStore(options.root);
    this.audit = new MarketAudit(this.store.root);
    this.fetcher = options.fetch ?? fetch;
  }

  get root() {
    return this.store.root;
  }

  sourceIds(): string[] {
    return this.sources.map(({ id }) => id);
  }

  events() {
    return this.audit.read();
  }

  record(event: Parameters<MarketAudit['record']>[0]) {
    return this.audit.record(event);
  }

  async scan(registry: string): Promise<RegistryCheck> {
    const source = this.source(registry);
    let releases: Release[];
    try {
      releases = await readIndex(source, this.fetcher);
    } catch (error) {
      return this.audit.failed(registry, error instanceof Error ? error.message : String(error));
    }
    return this.audit.observe(
      registry,
      releases,
      this.active().filter((version) => version.registry === registry),
    );
  }

  list() {
    return this.store.list();
  }

  version(name: string, version: string): InstalledVersion {
    return this.store.readVersion(name, version);
  }

  active(): InstalledVersion[] {
    return this.store.active();
  }

  activeRoots(): string[] {
    return this.active().map(({ root }) => root);
  }

  async search(query = ''): Promise<Release[]> {
    const normalized = query.trim().toLocaleLowerCase();
    return (await this.catalog())
      .filter((release) => hasQuery(release, normalized))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || byVersion(a, b) || a.registry.localeCompare(b.registry),
      );
  }

  async news(): Promise<Release[]> {
    return (await this.catalog()).sort(
      (a, b) =>
        Date.parse(b.releasedAt) - Date.parse(a.releasedAt) ||
        a.name.localeCompare(b.name) ||
        byVersion(a, b),
    );
  }

  async updates(registry?: string): Promise<AvailableUpdate[]> {
    const currentVersions = this.active().filter(
      (version) => !registry || version.registry === registry,
    );
    if (!currentVersions.length) return [];
    const ids = new Set(currentVersions.map(({ registry }) => registry));
    const releases = await this.catalog(this.sources.filter(({ id }) => ids.has(id)));
    return currentVersions.flatMap((current) => {
      const candidate = releases
        .filter(
          ({ name, registry, version }) =>
            name === current.name &&
            registry === current.registry &&
            compareVersions(version, current.version) > 0,
        )
        .sort(byVersion)[0];
      return candidate ? [{ current, candidate }] : [];
    });
  }

  claimInstallation(
    reference: Pick<Release, 'name' | 'version' | 'registry' | 'digest'>,
    context: { runId: string; sessionId: string },
  ): void {
    this.audit.claimInstallation(
      reference.registry,
      {
        name: reference.name,
        version: reference.version,
        digest: reference.digest,
      },
      context,
    );
  }

  async stageExact(
    release: Pick<Release, 'name' | 'version' | 'registry' | 'digest'>,
  ): Promise<InstalledVersion> {
    const actual = (await this.search(release.name)).find(
      ({ name, version, registry, digest }) =>
        name === release.name &&
        version === release.version &&
        registry === release.registry &&
        digest === release.digest,
    );
    if (!actual)
      throw new Error('The exact skill revision is not present in the configured registry');
    return this.stageRelease(actual);
  }

  async stage(name: string, version?: string, registry?: string): Promise<InstalledVersion> {
    safeName(name);
    if (version !== undefined) safeVersion(version);
    const sources = registry === undefined ? this.sources : [this.source(registry)];
    const found = (await this.catalog(sources))
      .filter(
        (release) =>
          release.name === name && (version === undefined || release.version === version),
      )
      .sort(byVersion);
    if (!found.length) throw new Error(`Skill ${name}${version ? `@${version}` : ''} not found`);
    const registries = new Set(found.map((entry) => entry.registry));
    if (registries.size > 1)
      throw new Error(`Multiple registries offer ${name}; specify the registry id`);
    return this.stageRelease(found[0]!);
  }

  activate(
    name: string,
    version: string,
    digest: string,
    expected?: VersionReference | null,
  ): InstalledVersion {
    const old = this.active().find((entry) => entry.name === name);
    const next = this.store.activate(name, version, digest, expected);
    if (old?.digest !== next.digest || old.version !== next.version) {
      this.audit.record({
        type: 'market_activate',
        registry: next.registry,
        result: 'applied',
        old: old && { name, version: old.version, digest: old.digest },
        next: { name, version, digest },
      });
    }
    return next;
  }

  rollback(name: string): InstalledVersion {
    const old = this.active().find((entry) => entry.name === name);
    const next = this.store.rollback(name);
    this.audit.record({
      type: 'market_rollback',
      registry: next.registry,
      result: 'applied',
      old: old && { name, version: old.version, digest: old.digest },
      next: { name, version: next.version, digest: next.digest },
    });
    return next;
  }

  deactivate(name: string): void {
    this.store.deactivate(name);
  }

  async reconcile(
    gate?: UpdateGate,
    registry?: string,
    shouldAttempt: (update: AvailableUpdate) => boolean = () => true,
  ): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const update of (await this.updates(registry)).filter(shouldAttempt)) {
      let staged: InstalledVersion | undefined;
      try {
        staged = await this.stageRelease(update.candidate);
        if (!gate) {
          results.push({ update, staged, status: 'staged' });
        } else if (await gate(staged, update.current)) {
          this.activate(staged.name, staged.version, staged.digest, update.current);
          results.push({ update, staged, status: 'activated' });
        } else {
          results.push({ update, staged, status: 'blocked' });
        }
      } catch (error) {
        results.push({
          update,
          staged,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const result of results) this.recordUpdate(result);
    return results;
  }

  recordUpdate({ update, status, error }: ReconcileResult): void {
    const { current, candidate } = update;
    this.audit.record({
      type: 'market_update',
      registry: candidate.registry,
      old: { name: current.name, version: current.version, digest: current.digest },
      next: { name: candidate.name, version: candidate.version, digest: candidate.digest },
      result: status,
      error,
    });
  }

  private source(id: string): RegistrySource {
    const source = this.sources.find((entry) => entry.id === id);
    if (!source) throw new Error(`Unknown registry: ${id}`);
    return source;
  }

  private async stageRelease(release: Release): Promise<InstalledVersion> {
    try {
      const installed = this.store.readVersion(release.name, release.version);
      if (installed.digest !== release.digest)
        throw new Error(`Release ${release.name}@${release.version} is immutable`);
      if (installed.registry !== release.registry)
        throw new Error(`Release ${release.name}@${release.version} belongs to another registry`);
      return installed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const data = await download(release, this.source(release.registry), this.fetcher);
    return this.store.stage(release, data);
  }

  private async catalog(sources: RegistrySource[] = this.sources): Promise<Release[]> {
    const results = await Promise.allSettled(
      sources.map((source) => readIndex(source, this.fetcher)),
    );
    const loaded = results.filter((result) => result.status === 'fulfilled');
    if (loaded.length || !results.length) return loaded.flatMap(({ value }) => value);
    throw (results[0] as PromiseRejectedResult).reason;
  }
}
