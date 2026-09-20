#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync,symlinkSync,openSync,writeSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createVerifiedDownloads} from '../platform/verified-download.mjs';
import {createGateway} from '../platform/gateway.mjs';

if(process.argv[2]==='--serve'){
  const fixture=JSON.parse(readFileSync(process.argv[3],'utf8'));
  const downloads=createVerifiedDownloads({directory:fixture.snapshots});
  const gateway=createGateway({});let peak=process.memoryUsage().rss,lag=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();lag=Math.max(lag,now-last-10);last=now;peak=Math.max(peak,process.memoryUsage().rss);},10);
  gateway.route('GET','/metrics',ctx=>ctx.send(200,{peak,rss:process.memoryUsage().rss,lag,...downloads.state()}));
  gateway.route('GET','/download',async ctx=>{
    let snapshot;
    try{
      snapshot=await downloads.prepare(fixture.path,fixture.receipt,{signal:ctx.signal});
      await ctx.sendStream(200,snapshot.stream(),{'content-length':String(snapshot.bytes),'content-type':'application/octet-stream','accept-ranges':'none'});
    }finally{await snapshot?.dispose();}
  });
  const server=gateway.listen(0,()=>process.send({port:server.address().port}));
  process.on('SIGTERM',()=>{clearInterval(timer);server.closeAllConnections();server.close(()=>process.exit(0));});
}else{
  const scratch=mkdtempSync(join(tmpdir(),'forge-verified-download.'));let child;
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const original=Buffer.from('the exact frozen artifact\n'),receipt={bytes:original.length,sha256:sha(original)};
  const path=join(scratch,'source'),snapshots=join(scratch,'snapshots');writeFileSync(path,original);
  const downloads=createVerifiedDownloads({directory:snapshots,concurrency:1,maxQueued:1,waitMs:1000});
  try{
    const held=await downloads.prepare(path,receipt);
    assert.deepEqual(readdirSync(snapshots),[],'unlinked snapshots leave no cached file');
    writeFileSync(path,'changed after verification');
    const chunks=[];for await(const chunk of held.stream())chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks),original,'delivery reads the verified snapshot, not the changed source');
    const cancelled=new AbortController();
    const waiting=downloads.prepare(path,receipt,{signal:cancelled.signal});
    const waitingError=assert.rejects(waiting,{code:'ABORT_ERR'});
    await assert.rejects(downloads.prepare(path,receipt),{code:'DOWNLOAD_BUSY'});
    cancelled.abort();await waitingError;await held.dispose();
    assert.deepEqual(downloads.state(),{active:0,queued:0,concurrency:1,maxQueued:1,maxBytes:512*1024*1024});
    writeFileSync(path,Buffer.alloc(original.length,120));
    await assert.rejects(downloads.prepare(path,receipt),{code:'ARTIFACT_INTEGRITY'});
    writeFileSync(path,original);symlinkSync(path,join(scratch,'link'));
    await assert.rejects(downloads.prepare(join(scratch,'link'),receipt));
    const limited=createVerifiedDownloads({directory:snapshots,maxBytes:2});
    await assert.rejects(limited.prepare(path,receipt),{code:'DOWNLOAD_LIMIT'});

    // Two 256 MiB downloads exercise the configured concurrent workload. The
    // parent hashes streamed responses; neither process buffers the payload.
    const largePath=join(scratch,'large'),fd=openSync(largePath,'wx');
    const block=Buffer.alloc(1024*1024,91),digest=createHash('sha256');
    for(let i=0;i<256;i++){writeSync(fd,block);digest.update(block);}closeSync(fd);
    const largeReceipt={bytes:256*1024*1024,sha256:digest.digest('hex')};
    const fixture=join(scratch,'fixture.json');writeFileSync(fixture,JSON.stringify({path:largePath,receipt:largeReceipt,snapshots}));
    child=spawn(process.execPath,[import.meta.filename,'--serve',fixture],{stdio:['ignore','ignore','pipe','ipc']});
    let childLog='';child.stderr.on('data',chunk=>childLog+=chunk);
    const [{port}]=await once(child,'message');const origin=`http://127.0.0.1:${port}`;
    const initial=await(await fetch(`${origin}/metrics`)).json();let finished=0,firstBytes=[];const healthTimes=[];
    const consume=async()=>{
      const start=performance.now(),response=await fetch(`${origin}/download`,{headers:{range:'bytes=0-3'}});
      assert.equal(response.status,200);assert.equal(response.headers.get('accept-ranges'),'none');
      firstBytes.push(performance.now()-start);const hash=createHash('sha256');let bytes=0;
      for await(const chunk of response.body){hash.update(chunk);bytes+=chunk.length;}
      assert.equal(bytes,largeReceipt.bytes);assert.equal(hash.digest('hex'),largeReceipt.sha256);finished++;
    };
    const transfers=Promise.all([consume(),consume()]);
    while(finished<2){
      const start=performance.now();assert.equal((await fetch(`${origin}/healthz`)).status,200);healthTimes.push(performance.now()-start);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await transfers;await new Promise(resolve=>setTimeout(resolve,50));
    const measured=await(await fetch(`${origin}/metrics`)).json();
    const memoryGrowth=measured.peak-initial.rss,worstHealth=Math.max(...healthTimes);
    assert.ok(memoryGrowth<128*1024*1024,`bounded RSS growth: ${memoryGrowth} bytes`);
    assert.ok(worstHealth<750,`unrelated requests remain responsive: ${worstHealth}ms`);
    assert.equal(measured.active,0);assert.equal(measured.queued,0);
    assert.deepEqual(readdirSync(snapshots),[]);
    // Corruption must return an error envelope before any artifact bytes.
    const corruptFd=openSync(largePath,'r+');writeSync(corruptFd,Buffer.from([0]),0,1,0);closeSync(corruptFd);
    const corrupt=await fetch(`${origin}/download`);assert.equal(corrupt.status,503);assert.match(corrupt.headers.get('content-type'),/json/);
    assert.ok((await corrupt.text()).length<2000);
    // Abort during verification and delivery, then prove slots are reclaimed.
    const repairedFd=openSync(largePath,'r+');writeSync(repairedFd,Buffer.from([91]),0,1,0);closeSync(repairedFd);
    const requestAbort=new AbortController();
    const abortedFetch=fetch(`${origin}/download`,{signal:requestAbort.signal});
    const abortCheck=assert.rejects(abortedFetch,error=>error.name==='AbortError');
    for(let attempt=0;attempt<100;attempt++){
      if((await(await fetch(`${origin}/metrics`)).json()).active)break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    requestAbort.abort();await abortCheck;
    const delivered=await fetch(`${origin}/download`),reader=delivered.body.getReader();
    assert.equal(delivered.status,200);await reader.read();await reader.cancel();
    let afterCancel;
    for(let attempt=0;attempt<200;attempt++){
      afterCancel=await(await fetch(`${origin}/metrics`)).json();if(afterCancel.active===0)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(afterCancel.active,0,'aborting verification/delivery releases all snapshot slots');
    console.log(JSON.stringify({check:'verified-download',artifactMiB:256,concurrent:2,rssGrowthMiB:Math.round(memoryGrowth/1048576),
      worstHealthMs:Math.round(worstHealth),eventLoopLagMs:Math.round(measured.lag),firstByteMs:firstBytes.map(Math.round)},null,2));
    assert.ok(!childLog.includes('UnhandledPromiseRejection'),childLog);
    console.log('VERIFIED DOWNLOAD GREEN — complete hash before bytes, snapshot identity, bounded concurrency/memory, responsive health, corruption, range policy and queued cancellation.');
  }finally{
    if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}
    rmSync(scratch,{recursive:true,force:true});
  }
}
