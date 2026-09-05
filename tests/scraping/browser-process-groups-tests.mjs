import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BrowserProcessGroups } from '../../bin/browser-process-groups.mjs';

test('cancellation kills a TERM-resistant grandchild after its parent exits', async () => {
  const groups = new BrowserProcessGroups();
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore']}); console.log(c.pid); setTimeout(()=>process.exit(),200);`;
  const parent = groups.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [data] = await once(parent.stdout, 'data');
  const pid = Number(String(data).trim());
  await once(parent, 'exit');
  assert.ok(pid > 0); process.kill(pid, 0);
  assert.equal(await groups.stop(), true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.throws(() => groups.spawn(process.execPath, ['-e', '']), /stopping/);
});
