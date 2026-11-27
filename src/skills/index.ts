import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { AgentEvent, ToolDefinition } from '../types.js';

interface SkillMetadata {
  name: string;
  description: string;
}

interface Skill extends SkillMetadata {
  document: string;
}

type CatalogEvent = Pick<AgentEvent, 'type' | 'data'>;
const maxSkillBytes = 64 * 1024;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  if (
    typeof field.name !== 'string' ||
    field.name.length > 64 ||
    !namePattern.test(field.name) ||
    field.name !== name
  ) {
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

function scan(root: string, skills: Map<string, Skill>, events: CatalogEvent[]): void {
  let folders;
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('Skill root must be a directory');
    folders = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    events.push(diagnostic(root, error));
    return;
  }
  for (const folder of folders) {
    const path = join(root, folder.name);
    if (folder.isSymbolicLink()) {
      events.push(diagnostic(path, 'Skill links are not followed'));
      continue;
    }
    if (!folder.isDirectory()) continue;
    try {
      const skill = parseSkill(path, folder.name);
      if (skills.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
      skills.set(skill.name, skill);
    } catch (error) {
      events.push(diagnostic(path, error));
    }
  }
}

export function loadSkills(roots: string[]): {
  tools: ToolDefinition[];
  systemPrompt: string;
  initialEvents: CatalogEvent[];
} {
  const skills = new Map<string, Skill>();
  const initialEvents: CatalogEvent[] = [];
  for (const root of new Set(roots.map((path) => resolve(path)))) scan(root, skills, initialEvents);

  const catalog = [...skills.values()].map(({ name, description }) => ({ name, description }));
  initialEvents.unshift({
    type: 'skills_discovered',
    data: { skills: catalog, count: catalog.length },
  });
  if (!catalog.length) return { tools: [], systemPrompt: '', initialEvents };

  const loader: ToolDefinition = {
    name: 'load_skill',
    description:
      'Get the full instructions for one skill from the catalog. Call only when its description matches the current user task.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', enum: catalog.map(({ name }) => name) } },
      required: ['name'],
      additionalProperties: false,
    },
    sideEffect: false,
    safeRetry: true,
    async execute(args) {
      const skill = skills.get(String(args.name));
      if (!skill) return { ok: false, error: 'Skill is not in the discovered catalog' };
      return { ok: true, output: { name: skill.name, instructions: skill.document } };
    },
    source: { kind: 'skill' },
  };

  return {
    tools: [loader],
    initialEvents,
    systemPrompt: [
      'Optional skills are listed below by name and description.',
      'Before taking actions, decide whether a skill matches the current user request. Load a matching skill with load_skill and follow its instructions within existing tool policy. When no skill fits, use project tools directly.',
      JSON.stringify(catalog),
    ].join('\n'),
  };
}
