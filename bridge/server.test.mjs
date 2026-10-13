import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

/** A port nothing holds right now: the kernel picks it, and it is let go at once. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('the start banner says where the token is and never prints it', async (t) => {
  // Its own HOME, so the bridge mints a token there rather than reading the
  // one this machine's extension is paired with.
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const child = spawn(process.execPath, [SERVER, '--port', String(await freePort())], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner within 10 s:\n${output}`)), 10_000);
    const read = (chunk) => {
      output += chunk;
      // The banner is one write of well under a pipe buffer, so it arrives whole.
      if (output.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the bridge exited with ${code}:\n${output}`));
    });
  });

  const tokenFile = join(home, '.quick-lookup', 'bridge-token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert.ok(token.length >= 32, 'the bridge minted a token');
  assert.ok(!output.includes(token), 'the token reached stdout or stderr');
  assert.ok(output.includes(tokenFile), 'the banner names the file the token is in');
  assert.match(output, /\.\/ctl pair/);
});
