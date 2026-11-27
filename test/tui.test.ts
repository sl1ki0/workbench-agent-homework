import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import type { Message } from '../src/types.js';

const ptyBridge = String.raw`
import errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 112, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)

def stop(signum, frame):
    if child.poll() is None:
        child.terminate()

signal.signal(signal.SIGTERM, stop)
sources = [master, sys.stdin.fileno()]
while True:
    readable, _, _ = select.select(sources, [], [], 0.1)
    if master in readable:
        try:
            data = os.read(master, 32768)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if sys.stdin.fileno() in readable:
        data = os.read(sys.stdin.fileno(), 32768)
        if not data:
            sources.remove(sys.stdin.fileno())
        else:
            os.write(master, data)
sys.exit(child.wait())
`;

class Screen {
  output = '';

  constructor(child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (chunk: string) => {
      this.output += chunk;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
  }

  text(after = 0): string {
    return stripVTControlCharacters(this.output.slice(after)).replaceAll('\r', '');
  }

  async expect(pattern: RegExp, after = 0): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!pattern.test(this.text(after)) && Date.now() < deadline) await delay(15);
    assert.match(this.text(after), pattern, `PTY output tail:\n${this.text().slice(-4500)}`);
  }
}

interface RequestBody {
  messages: Message[];
  reasoning_effort?: string;
  stream?: boolean;
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

function sse(response: ServerResponse, data: unknown): void {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function finish(
  response: ServerResponse,
  reason: 'stop' | 'tool_calls',
  input: number,
  output: number,
): void {
  sse(response, { choices: [{ index: 0, delta: {}, finish_reason: reason }] });
  sse(response, {
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  });
  response.end('data: [DONE]\n\n');
}

const canOpenPty =
  process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty, fcntl, termios'], { timeout: 1500 }).status === 0;

test(
  'interactive TTY renders changed rows, queues turns and controls skill and MCP catalogs',
  { skip: !canOpenPty && 'Python 3 with Unix PTY support is required', timeout: 20_000 },
  async (t) => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'workbench-tui-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'workspace');
    const state = join(directory, 'state');
    cpSync('workspace', workspace, { recursive: true });

    const releaseTools = gate();
    const releaseFinal = gate();
    const requests: RequestBody[] = [];
    let finalResponseEnded = false;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        if (requests.length === 1) {
          sse(response, {
            choices: [{ index: 0, delta: { reasoning_content: 'hidden-reasoning-sentinel' } }],
          });
          await releaseTools.wait;
          sse(response, {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'read-tty-1',
                      type: 'function',
                      function: { name: 'list_files', arguments: '{"path":"."}' },
                    },
                  ],
                },
              },
            ],
          });
          finish(response, 'tool_calls', 40, 6);
        } else if (requests.length === 2) {
          sse(response, { choices: [{ index: 0, delta: { content: 'Visible stream fragment' } }] });
          await releaseFinal.wait;
          sse(response, { choices: [{ index: 0, delta: { content: ' completed.' } }] });
          finish(response, 'stop', 11, 3);
          finalResponseEnded = true;
        } else if (requests.length === 3) {
          sse(response, {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'write-queued',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'new.txt', content: 'confirmation' }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          finish(response, 'tool_calls', 21, 4);
        } else {
          sse(response, {
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    requests.length === 4 ? 'Decision received.' : 'Second queued turn done.',
                },
              },
            ],
          });
          finish(response, 'stop', 11, 3);
        }
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    t.after(() => {
      releaseTools.open();
      releaseFinal.open();
      server.closeAllConnections();
      server.close();
    });

    const child = spawn(
      'python3',
      [
        '-u',
        '-c',
        ptyBridge,
        process.execPath,
        'dist/src/cli/index.js',
        'chat',
        '--plan',
        '--workspace',
        workspace,
        '--state-dir',
        state,
      ],
      {
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          AGENT_PROVIDER: 'compatible',
          OPENAI_MODEL: 'test-pty-model',
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_REASONING_EFFORT: 'none',
          OPENAI_TIMEOUT_MS: '9000',
        },
      },
    );
    const closed = once(child, 'close');
    const screen = new Screen(child);
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    });

    async function key(sequence: string, visible: RegExp): Promise<void> {
      const offset = screen.output.length;
      child.stdin.write(sequence);
      await screen.expect(visible, offset);
    }

    await screen.expect(/\bPlan\b/u);
    await screen.expect(/test-pty-model/u);
    await screen.expect(/MCP/iu);
    await screen.expect(/tracker/iu);
    await key('\t', /Ask for edits/iu);
    await key('\t', /\bYOLO\b/u);
    await key('\u001b[Z', /Ask for edits/iu);
    await key('/statu', /\/status/u);
    await key('\u0015/thinking low\r', /(?:thinking|рассуждени)[^\n]{0,100}\blow\b/iu);

    const activity = screen.output.length;
    child.stdin.write('obsolete draft\u001b[D\u001b[D\u0015List the workspace.\r');
    await screen.expect(/Thinking · модель обдумывает запрос/u, activity);
    releaseTools.open();
    await screen.expect(/Thinking · сигнал от модели/u, activity);
    await screen.expect(/list_files/u, activity);
    await screen.expect(/Visible stream fragment/u, activity);
    assert.equal(finalResponseEnded, false, 'An answer fragment was rendered only after SSE ended');
    assert.equal(requests[0]?.messages.at(-1)?.content, 'List the workspace.');
    assert.equal(requests[0]?.reasoning_effort, 'low');
    assert.equal(requests[0]?.stream, true);
    assert.equal(requests[1]?.messages.at(-1)?.role, 'tool');
    await screen.expect(/вход 40/u, activity);
    await key('Discard this.\r', /Очередь · 1 · Discard this/u);
    await key('/queue clear\r', /Очередь очищена · снято 1/u);
    await key('Queued first.', /› Queued first\./u);
    const idleUpdates = screen.output.length;
    await delay(320);
    const repeated = screen.output.slice(idleUpdates);
    assert.match(repeated, /\u001b\[\?2026h/u);
    assert.match(repeated, /\u001b\[\?2026l/u);
    assert.doesNotMatch(repeated, /\u001b\[J|\u001b\[\?25l|Queued first/u);
    await key('\r', /Очередь · 1 · Queued first/u);
    await key('Queued second.\r', /Очередь · 2 · Queued first/u);
    await key('/queue\r', /2\. Queued second/u);
    await key('\t', /\[YOLO\]/u);
    assert.equal(
      requests.length,
      2,
      'Queued prompts reached the provider before the active turn ended',
    );

    releaseFinal.open();
    await screen.expect(/Visible stream fragment completed\./u, activity);
    await screen.expect(/ждёт подтверждения/u, activity);
    assert.equal(requests.length, 3, 'A follow-up bypassed pending confirmation');
    assert.equal(requests[2]?.messages.at(-1)?.content, 'Queued first.');
    assert.ok(
      requests[2]?.messages.some(({ content }) => content === 'Visible stream fragment completed.'),
    );
    await key('/deny\r', /Second queued turn done\.[\s\S]*?завершён/u);
    assert.equal(requests[4]?.messages.at(-1)?.content, 'Queued second.');
    assert.ok(requests[4]?.messages.some(({ content }) => content === 'Decision received.'));

    await key('/skills list\r', /╭─ Skills · 1\/3/u);
    await key('\u001b[B', /› ● presentation-design/u);
    await key('progress', /Поиск › progress/u);
    await key('\r', /› ○ progress-summary · выключен · ≈ \d+ токенов/u);
    await key('\u0005', /каталог выключен/u);
    await key('\u0005', /каталог включён/u);
    await key('\u001b', /› Сообщение или \/команда/u);

    await key('/mcp list\r', /› ● tracker · подключён · stdio/u);
    await key('tracker', /Поиск › tracker/u);
    await key('\r', /› ○ tracker · выключен · stdio/u);
    await key('\u001b', /› Сообщение или \/команда/u);
    await key('/mcp list\r', /› ○ tracker · выключен · stdio/u);
    await key('\r', /› ● tracker · подключён · stdio/u);
    await key('\u0012', /Проверка завершена/u);
    await key('\u001b', /› Сообщение или \/команда/u);

    child.stdin.write('/exit\r');
    const [code] = await closed;
    assert.equal(code, 0, screen.text().slice(-3500));
    assert.equal(requests.length, 5);
    assert.equal(existsSync(join(workspace, 'new.txt')), false);
    assert.ok(
      requests.every(({ messages }) =>
        messages.every(({ content }) => content !== 'Discard this.'),
      ),
    );
    assert.doesNotMatch(screen.text(), /hidden-reasoning-sentinel/u);
    const journals = readdirSync(join(state, 'events')).map((file) =>
      readFileSync(join(state, 'events', file), 'utf8'),
    );
    assert.doesNotMatch(journals.join(''), /hidden-reasoning-sentinel/u);
    assert.match(journals.join(''), /"name":"list_files"/u);
  },
);
