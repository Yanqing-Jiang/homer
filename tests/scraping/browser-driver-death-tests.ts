import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserDriverAlive } from '../../src/scraping/browser-control.js';

test('SIGKILL of wrapper retains its durable group fence until the driver exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-death-')); const socket = join(dir, 'control.sock');
  const module = resolve('bin/browser-process-groups.mjs');
  const script = `import {BrowserProcessGroups} from ${JSON.stringify(module)}; const g=new BrowserProcessGroups(${JSON.stringify(socket)}+'.drivers.'+process.pid+'.json'); g.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore']}); console.log('ready'); setInterval(()=>{},1000);`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio:['ignore','pipe','inherit']});
  let groups: number[] = [];
  try {
    await once(wrapper.stdout!, 'data');
    groups = JSON.parse(readFileSync(`${socket}.drivers.${wrapper.pid}.json`, 'utf8'));
    const exited = once(wrapper, 'exit'); wrapper.kill('SIGKILL'); await exited;
    assert.equal(browserDriverAlive(`browserctl-agent:${wrapper.pid}`, socket), true);
    for (const pid of groups) process.kill(-pid, 'SIGKILL');
    const deadline = Date.now()+2000;
    while (browserDriverAlive(`browserctl-agent:${wrapper.pid}`, socket) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    assert.equal(browserDriverAlive(`browserctl-agent:${wrapper.pid}`, socket), false);
  } finally {
    wrapper.kill(); for(const pid of groups) try {process.kill(-pid,'SIGKILL');} catch {}
    rmSync(dir,{recursive:true,force:true});
  }
});
