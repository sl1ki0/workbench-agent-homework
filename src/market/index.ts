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

export { readMarketConfig } from './registry.js';
export type { VersionReference } from './store.js';
export type * from './types.js';

function byVersion(left: Release, right: Release): number {
  return compareVersions(right.version, left.version);
}

function hasQuery(release: Release, query: string): boolean {
  return `${release.name} ${release.description} ${release.registry}`
    .toLocaleLowerCase()
    .includes(query);
}

export class Market {
  private readonly store: MarketStore;
  private readonly sources: RegistrySource[];
  private readonly fetcher: typeof fetch;

  constructor(options: MarketOptions) {
    this.sources = normalizeRegistries(options.registries);
    this.store = new MarketStore(options.root);
    this.fetcher = options.fetch ?? fetch;
  }

  get root() {
    return this.store.root;
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

  async updates(): Promise<AvailableUpdate[]> {
    const currentVersions = this.active();
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
    return this.store.activate(name, version, digest, expected);
  }

  rollback(name: string): InstalledVersion {
    return this.store.rollback(name);
  }

  deactivate(name: string): void {
    this.store.deactivate(name);
  }

  async reconcile(gate?: UpdateGate): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const update of await this.updates()) {
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
    return results;
  }

  private source(id: string): RegistrySource {
    const source = this.sources.find((entry) => entry.id === id);
    if (!source) throw new Error(`Unknown registry: ${id}`);
    return source;
  }

  private async stageRelease(release: Release): Promise<InstalledVersion> {
    const data = await download(release, this.source(release.registry), this.fetcher);
    return this.store.stage(release, data);
  }

  private async catalog(sources: RegistrySource[] = this.sources): Promise<Release[]> {
    return (await Promise.all(sources.map((source) => readIndex(source, this.fetcher)))).flat();
  }
}
