export interface RegistrySource {
  id: string;
  index: string;
}

export interface MarketOptions {
  root: string;
  registries: readonly RegistrySource[];
  fetch?: typeof fetch;
}

export interface Release {
  name: string;
  version: string;
  digest: string;
  description: string;
  registry: string;
  artifact: string;
  releasedAt: string;
  notes: string;
}

export interface InstalledVersion extends Omit<Release, 'artifact'> {
  installedAt: string;
  root: string;
}

export interface Activation {
  name: string;
  version: string;
  digest: string;
  date: string;
  action: 'activate' | 'rollback' | 'disable';
}

export interface InstalledSkill {
  name: string;
  active: InstalledVersion | null;
  versions: InstalledVersion[];
  history: Activation[];
}

export interface AvailableUpdate {
  current: InstalledVersion;
  candidate: Release;
}

export type UpdateGate = (
  candidate: InstalledVersion,
  current: InstalledVersion,
) => Promise<boolean>;

export interface ReconcileResult {
  update: AvailableUpdate;
  staged?: InstalledVersion;
  status: 'staged' | 'activated' | 'blocked' | 'failed';
  error?: string;
}
