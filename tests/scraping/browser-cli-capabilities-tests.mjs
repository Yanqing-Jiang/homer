import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('interactive request refuses an old broker before reserving or starting a driver', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'broker-cap-'));
  const socket = join(dir, 'b.sock');
  const requests = [];
  const server = createServer(client => client.once('data', data => {
    requests.push(JSON.parse(String(data)));
    client.end(JSON.stringify({ ok: true, result: { agentMode: true } }) + '\n');
  }));
  try {
    await new Promise(resolve => server.listen(socket, resolve));
    await assert.rejects(promisify(execFile)(process.execPath,
      ['bin/browserctl', 'agent', 'agent.fixture', '--instance', 'interactive', '--rpc'],
      { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socket }, timeout: 5000 }),
      error => error.code === 1 && /does not support instance interactive/.test(error.stderr));
    assert.deepEqual(requests, [{ verb: 'capabilities' }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
