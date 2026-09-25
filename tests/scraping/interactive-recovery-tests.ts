import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InteractiveBrowser } from '../../src/scraping/interactive-browser.js';

test('missing Chrome retains live expired owner on restart and recovers only after exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interactive-recovery-'));
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const pid = worker.pid!; const owner = `browserctl-agent:${pid}`;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({pid: 99999999, started:'gone', generation:2,
    holder: {reservation:{surface:'agent.old',owner,leaseId:'old',expiresAt:1,baselineTargetIds:[]},records:[]},
    owners:{[owner]:execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim()}}));
  const controller = new InteractiveBrowser(join(dir,'profile'), join(dir,'state.json'), 9608);
  try {
    await controller.initialize();
    await assert.rejects(controller.ready(), /previous driver/);
    assert.equal((await controller.status() as {state:string}).state, 'quarantined');
    // A live driver's renew meanwhile is "not restored yet" (retryable), never "unknown lease".
    assert.equal(controller.broker.restoring(), true);
    assert.throws(() => controller.broker.renew('old', 60), (error: Error & {code?: string}) => error.code === 'RESTORING');
    const exited = once(worker, 'exit'); worker.kill(); await exited;
    assert.equal((await controller.status() as {state:string}).state, 'idle');
    assert.equal(controller.broker.restoring(), false);
    assert.throws(() => controller.broker.renew('old', 60), /unknown or expired lease/);
  } finally { worker.kill(); controller.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test('multi-holder recovery remains quarantined until every persisted driver exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interactive-multi-'));
  const workers = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']));
  const owners = workers.map(worker => `browserctl-agent:${worker.pid}`);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ pid: 99999999, started: 'gone', generation: 2,
    holder: { reservations: owners.map((owner, i) => ({ surface: `agent.${i}`, owner, leaseId: String(i), expiresAt: 1, granted: true })), records: [] },
    owners: Object.fromEntries(workers.map((worker, i) => [owners[i], execFileSync('/bin/ps', ['-p', String(worker.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()])) }));
  const controller = new InteractiveBrowser(join(dir, 'profile'), join(dir, 'state.json'), 9608);
  try {
    await controller.initialize();
    assert.equal(controller.broker.maxAgents, 4);
    assert.equal((await controller.status() as { state: string }).state, 'quarantined');
    for (let i = 0; i < workers.length; i++) {
      const exited = once(workers[i]!, 'exit'); workers[i]!.kill(); await exited;
      assert.equal((await controller.status() as { state: string }).state, i === 0 ? 'quarantined' : 'idle');
    }
  } finally { workers.forEach(worker => worker.kill()); controller.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
