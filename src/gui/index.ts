import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnvFile } from 'node:process';
import { join } from 'node:path';
import { installationRoot } from '../cli/paths.js';
import type { AddressInfo } from 'node:net';
import type { CliOptions } from '../cli/options.js';
import {
  GuiRuntime,
  InputError,
  objectValue,
  type Activity,
  type GuiExtensions,
} from './runtime.js';

export type { GuiExtensions, GuiOperations } from './runtime.js';

const host = '127.0.0.1';
const limit = 128_000;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
] as const);

function prepare(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new InputError('Ожидался application/json', 415);
  if (Number(req.headers['content-length']) > limit)
    throw new InputError('Слишком большой запрос', 413);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    const data = Buffer.from(part);
    size += data.length;
    if (size > limit) {
      req.resume();
      throw new InputError('Слишком большой запрос', 413);
    }
    parts.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    throw new InputError('Некорректный JSON');
  }
}

function matchingToken(provided: string | string[] | undefined, token: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkOrigin(req: IncomingMessage, origin: URL, token: string, staticAsset: boolean): void {
  if (req.headers.host !== origin.host) throw new InputError('Недопустимый Host', 403);
  if (req.headers.origin && req.headers.origin !== origin.origin)
    throw new InputError('Недопустимый Origin', 403);
  const site = req.headers['sec-fetch-site'];
  if (!staticAsset && site && !['same-origin', 'none'].includes(site))
    throw new InputError('Недопустимый источник запроса', 403);
  if (
    req.method === 'POST' &&
    (req.headers.origin !== origin.origin ||
      !matchingToken(req.headers['x-workbench-token'], token))
  )
    throw new InputError('Запрос требует локальной авторизации', 403);
}

function pathMatch(path: string, pattern: RegExp): string | undefined {
  return path.match(pattern)?.[1];
}

async function stream(
  res: ServerResponse,
  action: (emit: (activity: Activity) => void) => Promise<unknown>,
): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
  res.flushHeaders();
  function write(value: unknown) {
    if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`);
  }
  try {
    const result = await action(write);
    write({ type: 'result', result });
  } catch (error) {
    write({ type: 'error', error: message(error) });
  } finally {
    if (!res.destroyed) res.end();
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  token: string,
  runtime: GuiRuntime,
): Promise<void> {
  const { pathname, searchParams } = url;
  const operation = pathname.match(/^\/api\/(market|evaluation|mcp)\/([a-z][a-z0-9-]*)$/u);
  if (req.method === 'GET') {
    const asset = assets.get(pathname as Parameters<typeof assets.get>[0]);
    if (asset) {
      const [filename, contentType] = asset;
      const source = readFileSync(join(installationRoot, 'src', 'gui', 'assets', filename));
      res.writeHead(200, { 'content-type': contentType });
      res.end(source);
      return;
    }
    if (pathname === '/api/bootstrap') return json(res, { token, ...runtime.bootstrap() });
    if (pathname === '/api/sessions') return json(res, runtime.sessions());
    if (pathname === '/api/inventory') return json(res, runtime.inventory());
    if (pathname === '/api/files') return json(res, runtime.listFiles());
    if (pathname === '/api/file') {
      const path = searchParams.get('path');
      if (!path) throw new InputError('Укажите путь файла');
      return json(res, runtime.file(path));
    }
    const session = pathMatch(pathname, /^\/api\/session\/([\w-]{1,80})$/u);
    if (session) return json(res, runtime.session(session));
    const logs = pathMatch(pathname, /^\/api\/logs\/([\w-]{1,80})$/u);
    if (logs) return json(res, runtime.logs(logs));
    const diff = pathMatch(pathname, /^\/api\/diff\/([\w-]{1,80})$/u);
    if (diff) return json(res, runtime.diff(diff));
    const doctor = pathMatch(pathname, /^\/api\/doctor\/([\w-]{1,80})$/u);
    if (doctor) return json(res, runtime.doctor(doctor));
  }
  if (req.method === 'POST') {
    if (pathname === '/api/settings') return json(res, runtime.settingsUpdate(await body(req)));
    if (pathname === '/api/skills') return json(res, runtime.skillsUpdate(await body(req)));
    if (pathname === '/api/rollback') return json(res, await runtime.rollback(await body(req)));
    if (pathname === '/api/run' || pathname === '/api/resume') {
      const data = await body(req);
      return stream(res, (emit) =>
        pathname === '/api/run' ? runtime.begin(data, emit) : runtime.resume(data, emit),
      );
    }
    if (operation) {
      const kind = operation[1] as 'market' | 'evaluation' | 'mcp';
      const group = runtime.extensions[kind];
      const action = operation[2];
      if (!action || !group || !Object.hasOwn(group, action))
        throw new InputError('Операция недоступна', 404);
      const handler = group[action];
      if (!handler) throw new InputError('Операция недоступна', 404);
      const result = await handler(objectValue(await body(req)));
      if (kind === 'mcp' && (action === 'add' || action === 'remove'))
        await runtime.refreshAfterMcpChange();
      return json(res, result);
    }
  }
  throw new InputError('Маршрут не найден', 404);
}

export async function openGui(options: CliOptions, extensions: GuiExtensions = {}) {
  if (existsSync(options.envFile) || options.explicitEnvFile) loadEnvFile(options.envFile);
  const runtime = await GuiRuntime.create(options, extensions);
  const token = randomBytes(32).toString('base64url');
  let origin: URL;
  const server = createServer((req, res) => {
    prepare(res);
    Promise.resolve()
      .then(() => {
        const url = new URL(req.url ?? '/', origin);
        if (url.origin !== origin.origin) throw new InputError('Недопустимый URL', 403);
        const staticAsset =
          req.method === 'GET' && assets.has(url.pathname as Parameters<typeof assets.has>[0]);
        checkOrigin(req, origin, token, staticAsset);
        return route(req, res, url, token, runtime);
      })
      .catch((error: unknown) => {
        if (res.headersSent || res.destroyed) return;
        json(res, { error: message(error) }, error instanceof InputError ? error.status : 400);
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(extensions.port ?? 0, host, () => {
        const { port } = server.address() as AddressInfo;
        origin = new URL(`http://${host}:${port}/`);
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}/`;
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).finally(() => runtime.dispose()));
  }
  return { url, close };
}

export async function serveGui(options: CliOptions, extensions: GuiExtensions = {}): Promise<void> {
  const gui = await openGui(options, extensions);
  console.log(`Workbench · ${gui.url}\nCtrl+C завершит сервер.`);
  await new Promise<void>((resolve, reject) => {
    function stop() {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      gui.close().then(resolve, reject);
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
