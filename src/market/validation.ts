import { createHash } from 'node:crypto';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/u;

export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid object: ${field}`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, field: string, max = 2048): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new Error(`Invalid string: ${field}`);
  }
  return value;
}

export function safeName(value: unknown, field = 'name'): string {
  const name = string(value, field, 64);
  if (!namePattern.test(name)) throw new Error(`Invalid ${field}: ${name}`);
  return name;
}

export function safeVersion(value: unknown): string {
  const version = string(value, 'version', 32);
  const match = versionPattern.exec(version);
  if (
    !match ||
    match
      .slice(1)
      .some((part) => !Number.isSafeInteger(Number(part)) || String(Number(part)) !== part)
  ) {
    throw new Error(`Unsupported version ${version}; expected MAJOR.MINOR.PATCH`);
  }
  return version;
}

export function compareVersions(a: string, b: string): number {
  const left = safeVersion(a).split('.').map(Number);
  const right = safeVersion(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function safeDigest(value: unknown): string {
  const digest = string(value, 'sha256', 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid SHA-256 digest');
  return digest;
}

export function calculateDigest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeArtifact(value: unknown): string {
  const artifact = string(value, 'artifact', 256);
  if (
    !artifact.endsWith('/SKILL.md') ||
    artifact.split('/').some((segment) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(segment))
  ) {
    throw new Error('Artifact must be a relative path ending in /SKILL.md');
  }
  return artifact;
}

export function date(value: unknown, field: string): string {
  const formatted = string(value, field, 48);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(formatted) || !Number.isFinite(Date.parse(formatted))) {
    throw new Error(`Invalid ISO UTC date: ${field}`);
  }
  return formatted;
}
