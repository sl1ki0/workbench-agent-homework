import type { SkillCatalogEntry } from '../skills/index.js';
import type { AgentEvent } from '../types.js';

export type InventoryEvent = Pick<AgentEvent, 'type' | 'data'>;
interface Inventory {
  skills: string[];
  catalog: SkillCatalogEntry[];
  servers: { name: string; tools: string[]; error?: string }[];
  skillErrors: number;
  skillsEnabled: boolean;
  mcpEnabled: boolean;
}

function itemName(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('name' in value)) return [];
  return typeof value.name === 'string' ? [value.name] : [];
}

export function inventory(
  events: InventoryEvent[],
  skillsEnabled: boolean,
  mcpEnabled: boolean,
  entries: SkillCatalogEntry[] = [],
): Inventory {
  const catalog = events.find(({ type }) => type === 'skills_discovered')?.data.skills;
  return {
    catalog: entries,
    skills: Array.isArray(catalog) ? catalog.flatMap(itemName) : [],
    servers: events.flatMap(({ type, data }) => {
      if (type !== 'mcp_connected' && type !== 'mcp_error') return [];
      return [
        {
          name: String(data.server ?? 'server'),
          tools: Array.isArray(data.tools)
            ? data.tools.filter((tool): tool is string => typeof tool === 'string')
            : [],
          error: type === 'mcp_error' ? String(data.error ?? '') : undefined,
        },
      ];
    }),
    skillErrors: events.filter(({ type }) => type === 'skill_error').length,
    skillsEnabled,
    mcpEnabled,
  };
}

export type { Inventory };
