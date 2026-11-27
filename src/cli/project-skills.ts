import { join } from 'node:path';
import { Market } from '../market/index.js';
import { loadSkills, readSkillSelection, writeSkillSelection } from '../skills/index.js';
import type { CliOptions } from './options.js';

export function projectSkills(options: CliOptions) {
  const { skillDirs, projectSkillDirs, stateDir } = options;
  if (!skillDirs.length && !projectSkillDirs.length) return undefined;
  const managed = new Market({ root: join(stateDir, 'market'), registries: [] });
  return loadSkills([...managed.activeRoots(), ...skillDirs], {
    ...readSkillSelection(stateDir),
    projectRoots: projectSkillDirs,
  });
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
