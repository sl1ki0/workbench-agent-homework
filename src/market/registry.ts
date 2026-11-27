import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RegistrySource, Release } from './types.js';
import {
  date,
  object,
  safeArtifact,
  safeDigest,
  safeName,
  safeVersion,
  string,
} from './validation.js';

const maxIndexBytes = 1024 * 1024;
export const maxSkillBytes = 64 * 1024;

function httpUrl(value: string): URL | undefined {
  if (!/^[a-zA-Z][a-zA-Z+.\d-]*:/u.test(value)) return undefined;
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error('Registry URLs must be HTTP(S) without credentials, query or fragment');
  }
  return url;
}

export function readRegular(path: string, maxBytes: number): Buffer {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw new Error(`Expected a regular file up to ${maxBytes} bytes`);
    }
    const buffer = readFileSync(handle);
    if (buffer.length > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    return buffer;
  } finally {
    closeSync(handle);
  }
}

function decodeJson(data: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
}

export function normalizeRegistries(input: readonly RegistrySource[], relativeTo = process.cwd()) {
  const seen = new Set<string>();
  return input.map((source) => {
    const id = safeName(source.id, 'registry id');
    if (seen.has(id)) throw new Error(`Duplicate registry id: ${id}`);
    seen.add(id);
    const index = string(source.index, 'registry index');
    return { id, index: httpUrl(index)?.toString() ?? resolve(relativeTo, index) };
  });
}

export function readMarketConfig(path: string): RegistrySource[] {
  const config = object(decodeJson(readRegular(path, maxIndexBytes)), 'market config');
  if (!Array.isArray(config.registries) || config.registries.length > 16) {
    throw new Error('Market requires a registries array with at most 16 entries');
  }
  const sources = config.registries.map((item: unknown) => {
    const spec = object(item, 'registry');
    return { id: string(spec.id, 'registry id'), index: string(spec.index, 'registry index') };
  });
  return normalizeRegistries(sources, dirname(resolve(path)));
}

async function fetchBytes(url: URL, fetcher: typeof fetch, maxBytes: number): Promise<Buffer> {
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: { accept: 'application/json, text/plain, text/markdown, application/octet-stream' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Registry request failed with HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Registry response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseRelease(value: unknown, registry: RegistrySource): Release {
  const entry = object(value, 'release');
  return {
    name: safeName(entry.name),
    version: safeVersion(entry.version),
    digest: safeDigest(entry.sha256),
    description: string(entry.description, 'description', 1024),
    registry: registry.id,
    artifact: safeArtifact(entry.artifact),
    releasedAt: date(entry.releasedAt, 'releasedAt'),
    notes: string(entry.notes, 'notes', 4096),
  };
}

export async function readIndex(
  registry: RegistrySource,
  fetcher: typeof fetch,
): Promise<Release[]> {
  const address = httpUrl(registry.index);
  const data = address
    ? await fetchBytes(address, fetcher, maxIndexBytes)
    : readRegular(registry.index, maxIndexBytes);
  const index = object(decodeJson(data), 'registry index');
  if (index.schema !== 1 || !Array.isArray(index.releases) || index.releases.length > 1000) {
    throw new Error(`Invalid version-1 index from ${registry.id}`);
  }
  const releases = index.releases.map((entry: unknown) => parseRelease(entry, registry));
  const identities = new Set<string>();
  for (const { name, version } of releases) {
    const id = `${name}@${version}`;
    if (identities.has(id)) throw new Error(`Duplicate release in ${registry.id}: ${id}`);
    identities.add(id);
  }
  return releases;
}

export async function download(
  release: Release,
  registry: RegistrySource,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const artifact = safeArtifact(release.artifact);
  const index = httpUrl(registry.index);
  if (index) {
    const url = new URL(artifact, index);
    if (url.origin !== index.origin)
      throw new Error('Artifact must stay inside the registry origin');
    return fetchBytes(url, fetcher, maxSkillBytes);
  }
  let path = realpathSync(dirname(registry.index));
  const components = artifact.split('/');
  for (const component of components.slice(0, -1)) {
    path = join(path, component);
    if (!lstatSync(path).isDirectory()) throw new Error('Artifact directory must not be a symlink');
  }
  return readRegular(join(path, components.at(-1) ?? ''), maxSkillBytes);
}
