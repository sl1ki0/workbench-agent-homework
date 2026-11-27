import { readSkillSelection } from '../skills/index.js';
import type { CatalogSource } from './catalog-panel.js';
import type { Inventory } from './inventory.js';
import { projectMcp } from './mcp-commands.js';
import type { CliOptions } from './options.js';
import { changeSkillSelection } from './project-skills.js';

export function projectCatalogs(
  options: CliOptions,
  inventory: Inventory,
  reloadSkills: () => void,
  reconnect: () => Promise<void>,
): { skills: CatalogSource; mcp: CatalogSource } {
  const manager = projectMcp(options);
  const skillsAllowed = options.skillDirs.length > 0 || options.projectSkillDirs.length > 0;
  const skillsEnabled = () => readSkillSelection(options.stateDir).enabled;

  function changeSkill(action: string, name?: string) {
    changeSkillSelection(options, action, name);
    reloadSkills();
  }

  return {
    skills: {
      subtitle: () =>
        !skillsAllowed
          ? 'отключены флагом'
          : skillsEnabled()
            ? 'каталог включён'
            : 'каталог выключен',
      list: () =>
        inventory.catalog.map((skill) => ({
          id: skill.name,
          enabled: skill.enabled,
          state: `${skill.enabled ? 'включён' : 'выключен'} · ≈ ${skill.estimatedTokens} токенов`,
          detail: skill.description,
        })),
      toggle(entry) {
        if (!skillsEnabled()) throw new Error('Сначала включите каталог через Ctrl+E.');
        changeSkill(entry.enabled ? 'disable' : 'enable', entry.id);
      },
      toggleAll: skillsAllowed ? () => changeSkill(skillsEnabled() ? 'off' : 'on') : undefined,
    },
    mcp: {
      subtitle: () => (manager ? 'локальная конфигурация' : 'отключены флагом'),
      list() {
        return (manager?.configured() ?? []).map((server) => {
          const live = inventory.servers.find(({ name }) => name === server.id);
          const status = !server.enabled
            ? 'выключен'
            : live?.error
              ? 'ошибка'
              : live
                ? 'подключён'
                : 'не проверен';
          return {
            id: server.id,
            enabled: server.enabled,
            state: `${status} · ${server.transport}`,
            detail:
              live?.error || live?.tools.join(', ') || 'Инструменты появятся после подключения.',
          };
        });
      },
      async toggle(entry) {
        if (!manager) return;
        manager.setEnabled(entry.id, !entry.enabled);
        await reconnect();
      },
      refresh: manager ? reconnect : undefined,
    },
  };
}
