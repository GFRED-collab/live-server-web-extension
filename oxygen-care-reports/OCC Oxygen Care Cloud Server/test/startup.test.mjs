import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('standalone service starts through the current-release symlink',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'occ-startup-'));
  await symlink(resolve('.'),join(dir,'current'),'dir');
  const child=spawn(process.execPath,[join(dir,'current','server.mjs')],{env:{...process.env,NODE_ENV:'test',OCC_DATA_DIR:join(dir,'data'),APP_ORIGIN:'http://127.0.0.1:3003',HOST:'127.0.0.1',PORT:'0'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  try{
    for(let attempt=0;attempt<100&&!output.includes('OCC listening');attempt++){
      if(child.exitCode!==null)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.match(output,/OCC listening on/,'Linked release failed to start: '+output);
    assert.equal(child.exitCode,null,'Service exited unexpectedly.');
  }finally{
    if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});
