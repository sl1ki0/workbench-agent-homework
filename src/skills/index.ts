import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentEvent, ToolDefinition } from '../types.js';
import { isSkillName, type SkillSelection } from './selection.js';

export { readSkillSelection, writeSkillSelection } from './selection.js';
export type { SkillSelection } from './selection.js';

interface SkillMetadata {
  name: string;
  description: string;
}

export interface SkillCatalogEntry extends SkillMetadata {
  enabled: boolean;
  estimatedTokens: number;
}

interface DiscoveryOptions extends Partial<SkillSelection> {
  projectRoots?: string[];
}

interface Skill extends SkillMetadata {
  document: string;
}

type CatalogEvent = Pick<AgentEvent, 'type' | 'data'>;
const maxSkillBytes = 64 * 1024;

function readDocument(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxSkillBytes) {
      throw new Error('SKILL.md must be a regular file up to 64 KiB');
    }
    return readFileSync(fd, 'utf8')
      .replace(/^\uFEFF/u, '')
      .replace(/\r\n/g, '\n');
  } finally {
    closeSync(fd);
  }
}

function parseSkill(folder: string, name: string): Skill {
  const document = readDocument(join(folder, 'SKILL.md'));
  const parts = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/u.exec(document);
  if (!parts?.[1] || !parts[2]?.trim())
    throw new Error('Expected YAML frontmatter and Markdown instructions');
  const parsed = parseDocument(parts[1], { uniqueKeys: true });
  if (parsed.errors.length) throw new Error(`Invalid YAML: ${parsed.errors[0]?.message}`);
  const metadata: unknown = parsed.toJS({ maxAliasCount: 0 });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Frontmatter must be a YAML mapping');
  }
  const field = metadata as Record<string, unknown>;
  if (!isSkillName(field.name) || field.name !== name) {
    throw new Error(
      'Name must match the folder and use 1–64 lowercase letters, digits and single hyphens',
    );
  }
  if (
    typeof field.description !== 'string' ||
    !field.description.trim() ||
    field.description.trim().length > 1024
  ) {
    throw new Error('Description must contain 1–1024 characters');
  }
  return { name, description: field.description.trim(), document };
}

function diagnostic(path: string, error: unknown): CatalogEvent {
  return {
    type: 'skill_error',
    data: { path, error: error instanceof Error ? error.message : String(error) },
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function scan(
  root: string,
  skills: Map<string, Skill>,
  events: CatalogEvent[],
  scope: 'trusted' | 'nested-project' | 'direct-project',
): void {
  const project = scope !== 'trusted';
  let folders;
  try {
    if (!lstatSync(root).isDirectory() || (project && realpathSync(root) !== root)) {
      throw new Error('Skill root must be a directory without symbolic links');
    }
    folders = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    if (!project || !missing(error)) events.push(diagnostic(root, error));
    return;
  }
  for (const folder of folders) {
    if (scope === 'direct-project' && folder.name === 'skills') continue;
    const path = join(root, folder.name);
    if (folder.isSymbolicLink()) {
      events.push(diagnostic(path, 'Skill links are not followed'));
      continue;
    }
    if (!folder.isDirectory()) continue;
    if (scope === 'direct-project') {
      try {
        lstatSync(join(path, 'SKILL.md'));
      } catch (error) {
        if (!missing(error)) events.push(diagnostic(path, error));
        continue;
      }
    }
    try {
      const skill = parseSkill(path, folder.name);
      if (skills.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
      skills.set(skill.name, skill);
    } catch (error) {
      events.push(diagnostic(path, error));
    }
  }
}

export function loadSkills(
  roots: string[],
  options: DiscoveryOptions = {},
): {
  tools: ToolDefinition[];
  systemPrompt: string;
  initialEvents: CatalogEvent[];
  catalog: SkillCatalogEntry[];
} {
  const skills = new Map<string, Skill>();
  const initialEvents: CatalogEvent[] = [];
  for (const root of new Set(roots.map((path) => resolve(path)))) {
    scan(root, skills, initialEvents, 'trusted');
  }
  for (const root of new Set(options.projectRoots?.map((path) => resolve(path)))) {
    scan(join(root, 'skills'), skills, initialEvents, 'nested-project');
    scan(root, skills, initialEvents, 'direct-project');
  }

  const enabled = options.enabled !== false;
  const disabled = new Set(options.disabled ?? []);
  const catalog: SkillCatalogEntry[] = [...skills.values()].map(
    ({ name, description, document }) => ({
      name,
      description,
      enabled: enabled && !disabled.has(name),
      estimatedTokens: Math.ceil(Buffer.byteLength(document, 'utf8') / 4),
    }),
  );
  const available = catalog
    .filter(({ enabled }) => enabled)
    .map(({ name, description }) => ({
      name,
      description,
    }));
  initialEvents.unshift({
    type: 'skills_discovered',
    data: {
      skills: available,
      count: catalog.length,
      catalog,
      enabled_count: available.length,
    },
  });
  if (!available.length) return { tools: [], systemPrompt: '', initialEvents, catalog };

  const loader: ToolDefinition = {
    name: 'load_skill',
    description:
      'Get the full instructions for one skill from the catalog. Call only when its description matches the current user task.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', enum: available.map(({ name }) => name) } },
      required: ['name'],
      additionalProperties: false,
    },
    sideEffect: false,
    safeRetry: true,
    async execute(args) {
      const name = String(args.name);
      const skill = skills.get(name);
      if (!skill || disabled.has(name)) {
        return { ok: false, error: 'Skill is not in the available catalog' };
      }
      return { ok: true, output: { name: skill.name, instructions: skill.document } };
    },
    source: { kind: 'skill' },
  };

  return {
    tools: [loader],
    initialEvents,
    catalog,
    systemPrompt: [
      'Optional skills are listed below by name and description.',
      'Before taking actions, decide whether a skill matches the current user request. Load a matching skill with load_skill and follow its instructions within existing tool policy. When no skill fits, use project tools directly.',
      JSON.stringify(available),
    ].join('\n'),
  };
}
