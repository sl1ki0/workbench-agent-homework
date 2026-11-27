import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSkills } from '../skills/index.js';
import { atomicJson, checkDirectory, exists, syncPath, withLock } from './files.js';
import { maxSkillBytes, readRegular } from './registry.js';
import type { Activation, InstalledSkill, InstalledVersion, Release } from './types.js';
import {
  calculateDigest,
  compareVersions,
  date,
  object,
  safeDigest,
  safeName,
  safeVersion,
  string,
} from './validation.js';

export type VersionReference = Pick<InstalledVersion, 'version' | 'digest'>;

interface SkillPointer {
  active: VersionReference | null;
  history: Activation[];
}

interface MarketState {
  schema: 1;
  skills: Record<string, SkillPointer>;
}

const maxManifestBytes = 2 * 1024 * 1024;

function readJson(path: string): Record<string, unknown> {
  return object(
    JSON.parse(readRegular(path, maxManifestBytes).toString('utf8')) as unknown,
    'market metadata',
  );
}

function pointer(value: unknown): VersionReference {
  const ref = object(value, 'active pointer');
  return { version: safeVersion(ref.version), digest: safeDigest(ref.digest) };
}

function readActivation(value: unknown, name: string): Activation {
  const item = object(value, 'history event');
  const action = item.action;
  if (
    item.name !== name ||
    (action !== 'activate' && action !== 'rollback' && action !== 'disable')
  ) {
    throw new Error('Invalid activation history');
  }
  return { ...pointer(item), name, action, date: date(item.date, 'activation date') };
}

function readPointer(value: unknown, name: string): SkillPointer {
  const item = object(value, 'skill pointer');
  if (!Array.isArray(item.history)) throw new Error('Invalid skill history');
  return {
    active: item.active === null ? null : pointer(item.active),
    history: item.history.map((entry: unknown) => readActivation(entry, name)),
  };
}

function createDirectory(path: string): void {
  if (!exists(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  checkDirectory(path);
}

function matches(left: VersionReference | null, right: VersionReference | null): boolean {
  return left?.version === right?.version && left?.digest === right?.digest;
}

export class MarketStore {
  readonly root: string;
  private readonly versions: string;
  private readonly state: string;
  private readonly lock: string;

  constructor(directory: string) {
    createDirectory(resolve(directory));
    this.root = realpathSync(directory);
    this.versions = join(this.root, 'versions');
    this.state = join(this.root, 'installed.json');
    this.lock = join(this.root, '.lock');
    createDirectory(this.versions);
  }

  stage(release: Release, data: Buffer): InstalledVersion {
    const name = safeName(release.name);
    const version = safeVersion(release.version);
    const digest = safeDigest(release.digest);
    if (calculateDigest(data) !== digest)
      throw new Error(`SHA-256 mismatch for ${name}@${version}`);
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return withLock(this.lock, () => {
      checkDirectory(this.versions);
      const namePath = join(this.versions, name);
      createDirectory(namePath);
      const destination = join(namePath, version);
      if (exists(destination)) {
        const installed = this.readVersion(name, version);
        if (installed.digest !== digest) throw new Error(`Release ${name}@${version} is immutable`);
        if (installed.registry !== release.registry)
          throw new Error(`Release ${name}@${version} belongs to another registry`);
        return installed;
      }

      const staging = mkdtempSync(join(namePath, '.stage-'));
      try {
        const skillFolder = join(staging, name);
        mkdirSync(skillFolder, { mode: 0o700 });
        const file = join(skillFolder, 'SKILL.md');
        writeFileSync(file, data, { flag: 'wx', mode: 0o400 });
        syncPath(file);
        const skillEvents = loadSkills([staging]).initialEvents;
        const failure = skillEvents.find(({ type }) => type === 'skill_error');
        if (failure) throw new Error(`Invalid SKILL.md: ${String(failure.data.error)}`);
        const catalog = skillEvents.find(({ type }) => type === 'skills_discovered')?.data.skills;
        if (!Array.isArray(catalog) || catalog[0]?.description !== release.description.trim()) {
          throw new Error('SKILL.md description differs from its registry metadata');
        }
        const { description, registry, releasedAt, notes } = release;
        atomicJson(join(staging, 'manifest.json'), {
          name,
          version,
          digest,
          description,
          registry,
          releasedAt,
          notes,
          installedAt: new Date().toISOString(),
        });
        syncPath(skillFolder);
        syncPath(staging);
        renameSync(staging, destination);
        syncPath(namePath);
        syncPath(this.versions);
        return this.readVersion(name, version);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    });
  }

  readVersion(name: string, version: string): InstalledVersion {
    checkDirectory(this.versions);
    const nameRoot = checkDirectory(join(this.versions, safeName(name)));
    const root = checkDirectory(join(nameRoot, safeVersion(version)));
    const manifest = readJson(join(root, 'manifest.json'));
    if (manifest.name !== name || manifest.version !== version)
      throw new Error('Manifest identity mismatch');
    const digest = safeDigest(manifest.digest);
    const data = readRegular(join(checkDirectory(join(root, name)), 'SKILL.md'), maxSkillBytes);
    if (calculateDigest(data) !== digest)
      throw new Error(`Installed skill ${name}@${version} failed SHA-256 validation`);
    return {
      name,
      version,
      digest,
      root,
      description: string(manifest.description, 'description', 1024),
      registry: safeName(manifest.registry, 'registry id'),
      releasedAt: date(manifest.releasedAt, 'release date'),
      notes: string(manifest.notes, 'notes', 4096),
      installedAt: date(manifest.installedAt, 'install date'),
    };
  }

  list(): InstalledSkill[] {
    checkDirectory(this.versions);
    const state = this.readState();
    const names = readdirSync(this.versions).sort();
    for (const name of Object.keys(state.skills)) {
      if (!names.includes(name)) throw new Error(`Missing installed skill: ${name}`);
    }
    return names.map((name) => {
      const path = checkDirectory(join(this.versions, safeName(name)));
      const versions = readdirSync(path)
        .filter((version) => !version.startsWith('.stage-'))
        .sort((a, b) => compareVersions(b, a))
        .map((version) => this.readVersion(name, version));
      const pointer = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
      return {
        name,
        versions,
        active: this.resolveActive(name, pointer),
        history: pointer?.history ?? [],
      };
    });
  }

  active(): InstalledVersion[] {
    const state = this.readState();
    return Object.entries(state.skills).flatMap(([name, pointer]) => {
      const active = this.resolveActive(name, pointer);
      return active ? [active] : [];
    });
  }

  activate(
    name: string,
    version: string,
    digest: string,
    expected?: VersionReference | null,
  ): InstalledVersion {
    return withLock(this.lock, () => {
      const target = this.readVersion(name, version);
      if (target.digest !== safeDigest(digest)) throw new Error('Candidate digest has changed');
      const state = this.readState();
      const current = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
      if (expected !== undefined && !matches(current?.active ?? null, expected)) {
        throw new Error('Active version has changed; rerun the update check');
      }
      if (matches(current?.active ?? null, target)) return target;
      this.record(state, target, 'activate', current);
      return target;
    });
  }

  rollback(name: string): InstalledVersion {
    return withLock(this.lock, () => {
      const state = this.readState();
      safeName(name);
      const current = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
      const target = current?.history.findLast(
        (entry) => entry.action !== 'disable' && !matches(current.active, entry),
      );
      if (!target) throw new Error(`No earlier active version of ${name}`);
      const version = this.readVersion(name, target.version);
      if (!matches(version, target)) throw new Error('Previous version failed manifest validation');
      this.record(state, version, 'rollback', current);
      return version;
    });
  }

  deactivate(name: string): void {
    withLock(this.lock, () => {
      const state = this.readState();
      safeName(name);
      const current = Object.hasOwn(state.skills, name) ? state.skills[name] : undefined;
      if (!current?.active) throw new Error(`No active version of ${name}`);
      const version = this.readVersion(name, current.active.version);
      this.record(state, version, 'disable', current);
    });
  }

  private readState(): MarketState {
    if (!exists(this.state))
      return { schema: 1, skills: Object.create(null) as Record<string, SkillPointer> };
    const manifest = readJson(this.state);
    if (manifest.schema !== 1) throw new Error('Unsupported market manifest schema');
    const values = object(manifest.skills, 'installed skills');
    return {
      schema: 1,
      skills: Object.fromEntries(
        Object.entries(values).map(([name, value]) => [safeName(name), readPointer(value, name)]),
      ),
    };
  }

  private resolveActive(name: string, state?: SkillPointer): InstalledVersion | null {
    if (!state?.active) return null;
    const active = this.readVersion(name, state.active.version);
    if (active.digest !== state.active.digest)
      throw new Error('Active version failed manifest validation');
    return active;
  }

  private record(
    state: MarketState,
    version: InstalledVersion,
    action: Activation['action'],
    earlier?: SkillPointer,
  ): void {
    const { name, digest } = version;
    const ref = { version: version.version, digest };
    state.skills[name] = {
      active: action === 'disable' ? null : ref,
      history: [
        ...(earlier?.history ?? []),
        { ...ref, name, action, date: new Date().toISOString() },
      ],
    };
    atomicJson(this.state, state);
  }
}
