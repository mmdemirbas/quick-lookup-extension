#!/usr/bin/env node
/**
 * The local bridge: answer the panel from Claude Code instead of the API.
 *
 * Why it exists. The API backend is metered and needs a key sitting in
 * browser storage. This one uses the subscription already on the machine and
 * puts no key in the browser at all. What it costs instead is that it only
 * works here, only while this process is running.
 *
 * It speaks the **same wire format** the API backend does — POST a Messages
 * body, read Anthropic-shaped SSE back — so the extension's `streamChat()`
 * parses both without knowing which answered. That was the point of putting
 * the seam there.
 *
 * Run it:
 *   node bridge/server.mjs            # 127.0.0.1:8787
 *   node bridge/server.mjs --port 9000
 *
 * Zero dependencies, like the rest of this repo.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const STATE_DIR = join(homedir(), '.quick-lookup');
const TOKEN_FILE = join(STATE_DIR, 'bridge-token');

/**
 * A directory with nothing in it, used as the child's working directory.
 *
 * Not cosmetic. Claude Code reads `CLAUDE.md` and the rules around its cwd,
 * and running in a real project drags that whole environment into every
 * question about a web page — measured at 25,012 cache-creation tokens for a
 * two-letter answer, against 10,926 from an empty directory with the flags
 * below. None of it has anything to do with the page being discussed.
 */
const NEUTRAL_DIR = join(STATE_DIR, 'workspace');

/**
 * How long one answer may take before the child is killed.
 *
 * A `claude` process that never returns holds a subscription slot and a
 * pipe for as long as the client stays connected, which for a side panel
 * left open is indefinitely. Generous enough that a genuinely slow answer
 * finishes, short enough that a wedged one does not become permanent.
 */
const ANSWER_TIMEOUT_MS = 180_000;

/**
 * How many answers may be in flight at once.
 *
 * Each one is a process. The token keeps strangers out, but it does not stop
 * a bug — or several windows of the panel — from starting more of them than
 * this machine should be running, and there is no natural ceiling otherwise.
 */
const MAX_CONCURRENT = 4;
let active = 0;

/**
 * The shared secret, because loopback is not authentication.
 *
 * Any page in the browser can `fetch('http://127.0.0.1:8787')`. It cannot
 * read the reply without CORS, but it can absolutely send the request, and
 * that alone is enough to spend the subscription this exists to use. A source
 * address is not a peer identity; a token is.
 */
function loadToken() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(NEUTRAL_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Length-guarded, so the comparison itself does not leak the length. */
function tokenMatches(given, expected) {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Renders the Messages body as the single prompt the CLI takes.
 *
 * The API path sends structured turns; `claude -p` takes one string. Turns
 * are marked rather than run together, for the same reason the page is
 * wrapped in tags: the model has to be able to tell who said what, and a page
 * excerpt contains sentences that read exactly like instructions.
 */
export function flatten(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    const text = Array.isArray(message.content)
      ? message.content.map((block) => block.text ?? '').join('\n\n')
      : (message.content ?? '');
    if (!text.trim()) continue;
    parts.push(message.role === 'assistant' ? `Assistant:\n${text}` : `User:\n${text}`);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Everything a conversation about a web page does not need.
 *
 * `--restricted` alone is not enough, which is worth stating because the name
 * suggests it is. It removes Bash, PowerShell and the REPL — the ones that
 * run code — and **leaves `Edit`, `Write` and `NotebookEdit`**, verified by
 * reading the tool list out of the session's own `init` event: 26 tools
 * remain and those three are among them.
 *
 * That gap matters here more than it would anywhere else. The prompt contains
 * a web page the reader did not write, so the input is attacker-controlled by
 * construction, and a page that can talk an agent into writing a file has a
 * foothold on the reader's machine. Nothing in "what is this post arguing"
 * needs to write anything.
 *
 * The reading and network tools go too. `WebSearch` would genuinely help with
 * "is this claim true", and it is still refused: a page that can steer a fetch
 * can put the page's own contents in the URL, which turns a reading tool into
 * an exfiltration channel. Re-admitting it needs a way to stop the page
 * choosing the query, and that does not exist yet.
 */
const FORBIDDEN_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'WebFetch',
  'WebSearch',
];

function childArgs(model, system) {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--restricted',
    '--disallowed-tools', ...FORBIDDEN_TOOLS,
    '--strict-mcp-config',
    '--no-session-persistence',
    // An empty settings object, so the reader's own hooks do not run for
    // every question asked of a web page.
    '--settings', '{}',
    // Replaces the coding-agent framing rather than appending to it. The
    // default system prompt is about editing a repository and is wrong here.
    '--system-prompt', system,
    ...(model ? ['--model', model] : []),
  ];
}

/**
 * One SSE frame, or nothing if the client has gone.
 *
 * The guard is not defensive noise. Two paths end the response while the
 * child is still producing: the reader closing the panel, and the `result`
 * event arriving with more buffered lines behind it in the same chunk. A
 * write after either one raises `ERR_STREAM_WRITE_AFTER_END` on a stream
 * nobody is listening to, which takes the whole daemon down with it — and
 * the daemon is shared by every tab.
 */
function sse(response, event, data) {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function answer(request, response) {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
    // A body this large is not a page, it is a mistake or an attack.
    if (raw.length > 4_000_000) request.destroy();
  });

  request.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Body was not JSON.' } }));
      return;
    }

    const prompt = flatten(body.messages);
    if (!prompt) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'No question in the request.' } }));
      return;
    }

    if (active >= MAX_CONCURRENT) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: `The bridge is already answering ${active} questions. Wait for one to finish.`,
          },
        }),
      );
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const child = spawn('claude', childArgs(body.model, body.system ?? ''), {
      cwd: NEUTRAL_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active += 1;
    child.stdin.end(prompt);

    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, ANSWER_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(deadline);
      active -= 1;
    });

    // The reader closed the panel or pressed stop. Without this the child
    // keeps thinking, and keeps spending, with nobody listening.
    //
    // On the *response*, not the request. A request whose body has fully
    // arrived emits `close` immediately, so listening there kills the child
    // about thirty milliseconds after starting it, every time, and reports it
    // as "exited with code null" because SIGTERM leaves no exit code.
    response.on('close', () => {
      if (!response.writableEnded) child.kill('SIGTERM');
    });

    let buffer = '';
    let sent = 0;
    let stderr = '';
    let started = false;

    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        // Deltas, when the CLI is streaming partial messages. This is the
        // event the panel actually renders.
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const delta = event.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            if (!started) {
              started = true;
              sse(response, 'message_start', {
                type: 'message_start',
                message: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } },
              });
            }
            sent += delta.text.length;
            sse(response, 'content_block_delta', {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: delta.text },
            });
          }
          continue;
        }

        if (event.type === 'result') {
          // Nothing streamed — an older CLI, or a turn that produced only a
          // final message. Send the whole result rather than an empty answer.
          if (!sent && typeof event.result === 'string' && event.result) {
            if (!started) {
              sse(response, 'message_start', {
                type: 'message_start',
                message: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } },
              });
            }
            sse(response, 'content_block_delta', {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: event.result },
            });
          }
          if (event.is_error) {
            sse(response, 'error', {
              type: 'error',
              error: { message: String(event.result ?? 'Claude Code reported an error.') },
            });
          }
          const usage = event.usage ?? {};
          sse(response, 'message_delta', {
            type: 'message_delta',
            usage: { output_tokens: usage.output_tokens ?? 0 },
          });
          sse(response, 'message_stop', { type: 'message_stop' });
          response.end();
        }
      }
    });

    child.on('error', (error) => {
      // Almost always "claude is not on PATH", which is worth saying in those
      // words rather than as a stack trace in a side panel.
      sse(response, 'error', {
        type: 'error',
        error: {
          message:
            error.code === 'ENOENT'
              ? 'The `claude` command was not found on PATH. Install Claude Code, or start the bridge from a shell that has it.'
              : `Could not start Claude Code: ${error.message}`,
        },
      });
      response.end();
    });

    child.on('close', (code) => {
      if (response.writableEnded) return;
      sse(response, 'error', {
        type: 'error',
        error: {
          message: timedOut
            ? `Claude Code did not answer within ${ANSWER_TIMEOUT_MS / 1000} seconds and was stopped.`
            : `Claude Code exited with code ${code}. ${stderr.slice(0, 400)}`.trim(),
        },
      });
      response.end();
    });
  });
}

function main() {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag === -1 ? DEFAULT_PORT : Number(process.argv[portFlag + 1]) || DEFAULT_PORT;
  const token = loadToken();

  const server = createServer((request, response) => {
    const origin = request.headers.origin ?? '';
    const fromExtension = origin.startsWith('chrome-extension://');
    // Belt and braces with the token. A browser sets `Origin` and a page
    // cannot forge it, so this turns away every web page even before the
    // token is checked; the token is what turns away everything that is not
    // a browser, where `Origin` is whatever the caller typed.
    const allowedOrigin = origin === '' || fromExtension;

    // Answering CORS is what lets the extension reach this without a
    // `http://127.0.0.1/*` host permission — which would have granted it
    // every other service on the machine as well, to solve this one problem.
    // The grant is per-origin and the token still decides everything else.
    if (fromExtension) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'origin');
    }

    // Before the token check, and it has to be: a preflight is sent by the
    // browser itself and carries no `Authorization`, so authenticating it
    // would refuse every request before the real one was ever made.
    if (request.method === 'OPTIONS') {
      if (!fromExtension) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!allowedOrigin || !tokenMatches(bearer, token)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Bad or missing bridge token.' } }));
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, backend: 'claude-code' }));
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/messages') {
      answer(request, response);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'No such route.' } }));
  });

  // Loopback, named explicitly. Omitting the host argument is a wildcard
  // bind, and this process can spend a subscription and start a subprocess.
  // Expected caller: the Quick Lookup extension in a browser on this machine.
  //
  // The banner says where the token is and never the token itself: whatever
  // runs this server - a terminal's scrollback, the ajans board's run log -
  // may keep its output, and a token in a log works for whoever reads it.
  server.listen(port, HOST, () => {
    const address = server.address();
    process.stdout.write(
      [
        `Quick Lookup bridge listening on http://${HOST}:${address.port}`,
        '',
        'In the extension settings, under Chat:',
        `  URL    http://${HOST}:${address.port}`,
        `  Token  the one in ${TOKEN_FILE}; ./ctl pair puts it on the clipboard`,
        '',
        'The token stays the same across restarts.',
        'Answers come from Claude Code with tools switched off, in an empty',
        `working directory (${NEUTRAL_DIR}).`,
        '',
      ].join('\n'),
    );
  });
}

// Importable for tests, runnable as a program.
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) main();
