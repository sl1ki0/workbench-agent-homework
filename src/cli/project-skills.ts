import { join } from 'node:path';
import { Market, type InstalledVersion } from '../market/index.js';
import { object, safeDigest, safeName, safeVersion } from '../market/validation.js';
import type { Run } from '../runtime/types.js';
import {
  loadSkills,
  readSkillSelection,
  writeSkillSelection,
  type SkillSelection,
} from '../skills/index.js';
import type { CliOptions } from './options.js';

type MarketRef = Pick<InstalledVersion, 'name' | 'version' | 'digest' | 'registry'>;

interface ProjectSkillSnapshot {
  selection: SkillSelection;
  market: MarketRef[];
}

const snapshotEvent = 'market_skill_snapshot';

function readSnapshot(run?: Pick<Run, 'events'>): ProjectSkillSnapshot | undefined {
  const saved = run?.events.find(({ type }) => type === snapshotEvent)?.data;
  if (!saved) return undefined;
  const selection = object(saved.selection, 'run skill selection');
  const { enabled, disabled } = selection;
  if (
    typeof enabled !== 'boolean' ||
    !Array.isArray(disabled) ||
    !disabled.every((name: unknown): name is string => typeof name === 'string') ||
    !Array.isArray(saved.market)
  ) {
    throw new Error('Некорректный снимок скиллов запуска');
  }
  return {
    selection: { enabled, disabled },
    market: saved.market.map((entry: unknown) => {
      const { name, version, digest, registry } = object(entry, 'run market version');
      return {
        name: safeName(name),
        version: safeVersion(version),
        digest: safeDigest(digest),
        registry: safeName(registry, 'registry id'),
      };
    }),
  };
}

function pinnedRoots(market: Market, references: MarketRef[]): string[] {
  return references.map(({ name, version, digest, registry }) => {
    const pinned = market.version(name, version);
    if (pinned.digest !== digest || pinned.registry !== registry) {
      throw new Error(`Скилл ${name}@${version} не совпадает со снимком запуска`);
    }
    return pinned.root;
  });
}

export function projectSkills(options: CliOptions, run?: Pick<Run, 'events'>) {
  const { skillDirs, projectSkillDirs, stateDir } = options;
  if (!skillDirs.length && !projectSkillDirs.length) return undefined;
  const managed = new Market({ root: join(stateDir, 'market'), registries: [] });
  const previous = readSnapshot(run);
  const active = previous ? [] : managed.active();
  const snapshot: ProjectSkillSnapshot = previous ?? {
    selection: readSkillSelection(stateDir),
    market: active.map(({ name, version, digest, registry }) => ({
      name,
      version,
      digest,
      registry,
    })),
  };
  const marketRoots = previous
    ? pinnedRoots(managed, previous.market)
    : active.map(({ root }) => root);
  const skills = loadSkills([...marketRoots, ...skillDirs], {
    ...snapshot.selection,
    projectRoots: projectSkillDirs,
  });
  skills.initialEvents.push({ type: snapshotEvent, data: { ...snapshot } });
  return skills;
}

export function changeSkillSelection(options: CliOptions, action: string, name?: string) {
  if (!options.skillDirs.length && !options.projectSkillDirs.length) {
    throw new Error('Скиллы отключены флагом --no-skills');
  }
  const selection = readSkillSelection(options.stateDir);
  if (action === 'on' || action === 'off') {
    selection.enabled = action === 'on';
  } else if (action === 'enable' || action === 'disable') {
    if (!name || !projectSkills(options)?.catalog.some((skill) => skill.name === name)) {
      throw new Error('Укажите имя скилла из /skills');
    }
    const disabled = new Set(selection.disabled);
    if (action === 'enable') disabled.delete(name);
    else disabled.add(name);
    selection.disabled = [...disabled];
  } else throw new Error('/skills on|off|enable NAME|disable NAME');
  writeSkillSelection(options.stateDir, selection);
}
