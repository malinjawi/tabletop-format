#!/usr/bin/env node
/** Exact candidate protocol and compatibility checks for integrated fields. */
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:net';
import yaml from 'js-yaml';
import {currentNandeckSources} from './lib/nandeck-layout.mjs';
import {buildStudioFields,studioSetup} from './lib/studio-fields.mjs';
const ROOT=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'forge-studio-fields.')),games=join(temp,'games'),dir=join(games,'netrunner-sg');
const fixture=resolve(process.argv[2]||join(ROOT,'examples/_fixtures/netrunner-sg'));
const git=(...args)=>execFileSync('git',args,{cwd:temp,encoding:'utf8'}).trim();
let server,logs='';
try{
  // Unrelated inherited fit errors stay visible; new or changed errors block.
  const ui=readFileSync(join(ROOT,'tools/studio-fields-ui.js'),'utf8');
  const keySource=ui.slice(ui.indexOf('function desAvailableFieldKey('),ui.indexOf('function desNewField(){'));
  const available=(name,keys=[])=>runInNewContext(keySource+'desAvailableFieldKey(name,keys)',{name,keys,desSlug:value=>value.toLowerCase().replace(/[^a-z0-9]+/g,'_')});
  assert.equal(available('3D Armor'),'field_3d_armor');
  assert.equal(available('Armor',['armor','armor_2']),'armor_3');
  assert.equal(available('Constructor'),'constructor_2');
  assert.equal(available('field_test',['field_test']),'field_test_2','temporary keys must not overwrite existing card attributes');
  const reportSource=ui.slice(ui.indexOf('function desFieldPreflightReport(){'),ui.indexOf('function desFieldComposerHtml(){'));
  const oldRegion={id:'body',src:'card.text',w:20,h:10};
  const state={slug:'test',origCards:[{id:'one',text:'Existing long text'}],cards:[{id:'one',text:'Existing long text',attributes:{armor:3}}],orig:{regions:[oldRegion]},layout:{regions:[structuredClone(oldRegion)]}};
  const oldIssue={level:'error',card:'one',region:'body',message:'Does not fit'};
  let issues=[oldIssue];
  const sandbox={DES:state,G:()=>({}),desFamilyPreflight:()=>issues,desSelectedPrinting:()=>null,desCardPreflight:()=>[oldIssue],layValue:(ctx)=>ctx.card.text,layResolve:()=>'',layStringify:String};
  const fitReport=()=>runInNewContext(reportSource+'desFieldPreflightReport()',sandbox);
  assert.equal(fitReport().blocking.length,0);assert.equal(fitReport().inherited.length,1);
  state.cards[0].text='Changed long text';assert.equal(fitReport().blocking.length,1,'changing affected text must block');state.cards[0].text='Existing long text';
  state.layout.regions[0].w=19;assert.equal(fitReport().blocking.length,1,'changing affected layout must block');state.layout.regions[0].w=20;
  issues=[...issues,{...oldIssue,region:'new_field'}];assert.equal(fitReport().blocking.length,1,'new field fit errors must block');
  const saveSource=ui.slice(ui.indexOf('async function desStudioCommit(){'));
  for(const scenario of ['unchanged','edit','navigate','cleanup-edit','network-error']){
    const state={slug:'game',family:{id:'program'},sel:'one',_draftReady:true};
    const candidate={base_ref:'base',cards:[{id:'one',name:'Reviewed'}]};
    let finish,requests=0,clears=0,queued=0,reopens=0;
    const context={DES:state,DES_REVIEW:{slug:'game',payload:{...structuredClone(candidate),review_token:'token'}},candidate,
      location:{hash:'#game'},document:{getElementById:()=>null},desStudioPayload:()=>context.candidate,
      desFieldPreflightReport:()=>({blocking:[]}),desFamilyPreflight:()=>[],desRenderFull:()=>{},authHdr:()=>({}),toast:()=>{},esc:String,
      fetch:()=>{requests++;return new Promise(resolve=>finish=resolve);},
      desDraftClearCurrent:async()=>{clears++;if(scenario==='cleanup-edit')context.candidate.cards[0].name='Newer';},
      desDraftQueue:()=>{queued++;},$:()=>({classList:{remove:()=>{}}}),
      loadProjectView:async()=>{},designFamilyEdit:async()=>{reopens++;}};
    const saving=runInNewContext(saveSource+'desStudioCommit()',context);
    await runInNewContext('desStudioCommit()',context);assert.equal(requests,1,'duplicate saves suppressed');
    if(scenario==='edit')context.candidate.cards[0].name='Newer';
    if(scenario==='navigate'){context.DES={slug:'other'};context.location.hash='#other';}
    finish({ok:scenario!=='network-error',status:503,json:async()=>({saved:true,commit:'next',message:'Saved',error:'Unavailable'})});
    await saving;assert.equal(state._studioSaving,false,'save lock always released');
    assert.equal(reopens,scenario==='unchanged'?1:0,'late saves must not reopen over newer work');
    assert.equal(clears,['unchanged','cleanup-edit'].includes(scenario)?1:0,'only the reviewed draft may be cleared');
    assert.equal(queued,['edit','cleanup-edit'].includes(scenario)?1:0,'newer edits are queued for recovery');
  }
  mkdirSync(games);cpSync(fixture,dir,{recursive:true,filter:path=>!path.split('/').includes('exports')});
  const cards=JSON.parse(readFileSync(join(dir,'components/cards.json'),'utf8')),game=yaml.load(readFileSync(join(dir,'game.yaml'),'utf8')),original=currentNandeckSources(dir);
  const program=cards.filter(card=>card.type==='program'),target=program[0],second=program[1];
  const setup=studioSetup(game,cards);setup.attribute_definitions.push({key:'armor',name:'Armor',type:'number',applies_to:['program']});
  const region={id:'field_armor',type:'richtext',src:'Armor\n{card.attributes.armor}',x:40,y:25,w:19,h:12,size_pt:9,align:'center',color:'#20252c',bg:'#f5f1e8'};
  const workspace={family:'program',setup,regions:[region]},candidate=structuredClone(cards);
  candidate.find(card=>card.id===target.id).attributes.armor=3;
  candidate.find(card=>card.id===second.id).attributes.armor=0;
  const addition=buildStudioFields(dir,candidate,workspace);
  assert.deepEqual(addition.files.map(file=>file.path),['game.yaml','templates/card-design/families/program.yaml','templates/card-design/manifest.yaml']);
  assert.deepEqual(currentNandeckSources(dir),original,'builder does not modify sources');
  assert.throws(()=>buildStudioFields(dir,candidate,{...workspace,regions:[{...region,id:original.families[0].layout.regions[0].id}]}),/unique stable/);
  assert.throws(()=>buildStudioFields(dir,candidate,{...workspace,regions:[{...region,x:1000}]}),/inside the card/);
  assert.throws(()=>buildStudioFields(dir,candidate,{...workspace,regions:[{...region,src:'card.attributes.unknown'}]}),/declared field/);
  const destructive=structuredClone(workspace);destructive.setup.attribute_definitions.shift();
  assert.throws(()=>buildStudioFields(dir,candidate,destructive),/Existing fields/);
  for(const file of addition.files)writeFileSync(join(dir,file.path),file.content);
  const updated=currentNandeckSources(dir);
  for(const family of original.families){const after=updated.families.find(item=>item.id===family.id);
    assert.deepEqual(after.layout,{...family.layout,regions:[...family.layout.regions,...(family.id==='program'?[region]:[])]},'existing regions, ordering, and other families preserved');}
  cpSync(fixture,dir,{recursive:true,filter:path=>!path.split('/').includes('exports')});
  git('init','-q');git('config','user.name','Workspace tests');git('config','user.email','workspace@example.invalid');git('config','core.hooksPath','/dev/null');git('config','commit.gpgsign','false');git('add','games');git('commit','-qm','fixture');
  const before=git('rev-parse','HEAD');
  const port=await new Promise(resolvePort=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolvePort(port));});});
  const origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[join(ROOT,'server.mjs'),'--port',String(port),'--games',games],{cwd:ROOT,env:{...process.env,DB:'sqlite',STORE1:'local',LOCAL_STORE_ROOT:temp,DB_PATH:join(temp,'platform.db'),CACHE_DIR:join(temp,'cache'),FARM_DIR:join(temp,'farm'),RELEASE_VAULT_DIR:join(temp,'vault'),FORGE_HUB_PATH:join(temp,'hub.html'),FORGE_PUBLIC_ORIGIN:origin,FORGE_LISTEN_HOST:'127.0.0.1',FORGE_REGISTRATION_MODE:'open',FORGE_RATE_MAX:'1000',FORGE_INCLUDE_TEST_FIXTURES:'1',FORGE_LOCAL_PRIVATE_PREVIEW:'0'},stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>logs=(logs+chunk).slice(-10000));
  let ready=false;for(let n=0;n<200;n++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(ready,logs);
  const api=async(path,body,token)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};
  const owner=await api('/api/auth/register',{handle:'workspace-owner',email:'workspace@example.invalid',password:'workspace-password-123'});assert.equal(owner.status,201);
  const outsider=await api('/api/auth/register',{handle:'workspace-outsider',email:'outsider@example.invalid',password:'workspace-password-123'});assert.equal(outsider.status,201);
  const db=new DatabaseSync(join(temp,'platform.db'));db.prepare("UPDATE games SET owner_id=? WHERE slug='netrunner-sg'").run(owner.data.user.id);db.close();
  const token=owner.data.token,route='/api/games/netrunner-sg/design/studio';
  const opened=await api('/api/games/netrunner-sg/design/svg/program',null,token);
  assert.equal(opened.status,200);assert.deepEqual(opened.data.setup,studioSetup(game,cards));
  const payload={base_ref:before,cards:candidate,workspace,svg:opened.data.svg};
  assert([403,404].includes((await api(route,payload,outsider.data.token)).status),'field setup is maintainer-only');
  assert.equal((await api(route+'?commit=1',payload,token)).status,409,'review required');
  assert.equal(git('rev-parse','HEAD'),before);
  const review=await api(route,payload,token);assert.equal(review.status,200,JSON.stringify(review.data));assert.equal(review.data.ok,true,JSON.stringify(review.data));
  assert.equal(git('rev-parse','HEAD'),before,'review never writes');assert.equal(readFileSync(join(dir,'game.yaml'),'utf8'),readFileSync(join(fixture,'game.yaml'),'utf8'));
  const tampered=structuredClone(payload);tampered.workspace.regions[0].x=30;
  assert.equal((await api(route+'?commit=1',{...tampered,review_token:review.data.review_token},token)).status,409,'changed placement invalidates review');
  const familyPath='templates/card-design/families/program.yaml',raw=readFileSync(join(dir,familyPath),'utf8');
  writeFileSync(join(dir,familyPath),raw+'\n# unrelated local change\n');
  assert.equal((await api(route+'?commit=1',{...payload,review_token:review.data.review_token},token)).status,409,'uncommitted source is preserved');writeFileSync(join(dir,familyPath),raw);
  const saved=await api(route+'?commit=1',{...payload,review_token:review.data.review_token},token);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.saved,true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'components/cards.json'),'utf8')),candidate,'only specified values changed, including zero');
  assert.equal(git('rev-list','--count',before+'..HEAD'),'1','one atomic commit');
  assert.equal((await api(route,payload,token)).status,409,'stale setup rejected');
  const next=await api('/api/games/netrunner-sg/design/svg/program',null,token);assert.equal(next.status,200);assert.deepEqual(next.data.layout.regions.find(item=>item.id==='field_armor'),region,'placement survives reopen');
  const untouched=await api('/api/games/netrunner-sg/design/svg/event',null,token);assert.deepEqual(untouched.data.layout,original.families.find(item=>item.id==='event').layout,'other family unchanged');
  const noOp=await api(route,{base_ref:next.data.ref,cards:next.data.cards,printings:next.data.printings,svg:next.data.svg},token);assert.equal(noOp.data.ok,true);assert.deepEqual(noOp.data.changed_files,[],'existing Studio SVG round trip still works');
  const metadata=structuredClone(next.data.setup);metadata.attribute_definitions.push({key:'playtest_note',name:'Playtest note',type:'string'});
  const metaPayload={base_ref:next.data.ref,cards:next.data.cards,workspace:{family:'program',setup:metadata,regions:[]}};
  const metaReview=await api(route,metaPayload,token);assert.equal(metaReview.data.ok,true,JSON.stringify(metaReview.data));assert.deepEqual(metaReview.data.changed_files,['game.yaml'],'editor-only field touches no cards or templates');
  console.log('PASS integrated fields: additive preservation, exact review, permissions, atomic save, zero values, reopen, stale/dirty rejection, legacy SVG, metadata-only fields');
}finally{if(server){server.kill('SIGTERM');await new Promise(resolveExit=>{if(server.exitCode!==null)resolveExit();else server.once('exit',resolveExit);});}rmSync(temp,{recursive:true,force:true});}
