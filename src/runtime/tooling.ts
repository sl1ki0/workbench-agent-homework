import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolCall, ToolDefinition, ToolResult } from '../types.js';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ajv = new Ajv({ strict: false, allErrors: true, ownProperties: true });

export function validators(tools: Iterable<ToolDefinition>): Map<string, ValidateFunction> {
  return new Map(
    [...tools].map((tool) => {
      if (tool.schema.$async) throw new Error(`Async schema unsupported for ${tool.name}`);
      return [tool.name, ajv.compile(tool.schema)];
    }),
  );
}

export function checkArguments(
  call: ToolCall,
  validator: ValidateFunction,
): Record<string, unknown> {
  const argumentsValue: unknown = JSON.parse(call.function.arguments);
  if (typeof argumentsValue !== 'object' || !argumentsValue || Array.isArray(argumentsValue)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  if (!validator(argumentsValue)) {
    throw new Error(`Invalid arguments: ${ajv.errorsText(validator.errors)}`);
  }
  return argumentsValue as Record<string, unknown>;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  }
  return value;
}

function canonical(text: string): string {
  try {
    return JSON.stringify(ordered(JSON.parse(text)));
  } catch {
    return text;
  }
}

export function sameCall(a: ToolCall, b: ToolCall): boolean {
  return (
    a.function.name === b.function.name &&
    canonical(a.function.arguments) === canonical(b.function.arguments)
  );
}

export function limitResult(
  result: ToolResult,
  remaining: number,
): {
  result: ToolResult;
  content: string;
  bytes: number;
} {
  const encoded = JSON.stringify(result);
  const originalBytes = Buffer.byteLength(encoded);
  if (originalBytes <= remaining) return { result, content: encoded, bytes: originalBytes };
  const head = Buffer.from(encoded)
    .subarray(0, Math.min(remaining, originalBytes))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  const limited: ToolResult = { ok: result.ok, output: head, truncated: true };
  if (result.error) limited.error = result.error.slice(0, 320);
  const marker = 'TRUNCATED: ';
  const available = Math.max(0, remaining - marker.length);
  const snippet = Buffer.from(head)
    .subarray(0, available)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  const content = remaining > marker.length ? marker + snippet : marker.slice(0, remaining);
  return { result: limited, content, bytes: Buffer.byteLength(content) };
}

const secretField = /^(?:api[_-]?key|authorization|password|secret|token)$/i;

export function redact(value: unknown): unknown {
  const environmentSecrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:api[_-]?key|(?:^|_)token|secret|password)/i.test(name) && (value?.length ?? 0) >= 8,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);

  function sanitize(item: unknown): unknown {
    if (typeof item === 'string') {
      let safe = item.replace(
        /\b(?:sk-(?:or-v1-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g,
        '[redacted]',
      );
      for (const secret of environmentSecrets) safe = safe.replaceAll(secret, '[redacted]');
      return safe;
    }
    if (Array.isArray(item)) return item.map(sanitize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, content]) => [
          key,
          secretField.test(key) && typeof content === 'string' ? '[redacted]' : sanitize(content),
        ]),
      );
    }
    return item;
  }

  return sanitize(value);
}
