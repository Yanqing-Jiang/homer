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
  const controller = new InteractiveBrowser(join(dir,'profile'), join(dir,'state.json'), 9448);
  try {
    await controller.initialize();
    await assert.rejects(controller.ready(), /previous driver/);
    assert.equal((await controller.status() as {state:string}).state, 'quarantined');
    const exited = once(worker, 'exit'); worker.kill(); await exited;
    assert.equal((await controller.status() as {state:string}).state, 'idle');
  } finally { worker.kill(); controller.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});
