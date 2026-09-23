#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { buildCardFieldSetup, cardFieldErrors } from './lib/card-fields.mjs';
import { buildCardStarter } from './lib/card-starter.mjs';
const game={attribute_definitions:[{key:'cost',type:'integer'}]}, cards=[{id:'one',name:'One',type:'character',attributes:{cost:0}},{id:'two',name:'Two',type:'spell',attributes:{cost:2}}];
const setup={card_types:['character','spell'],attribute_definitions:[{key:'cost',type:'integer',archived:true},{key:'health',name:'Health',type:'integer',required:true,applies_to:['character'],section:'Combat',default:5,minimum:1,maximum:10},{key:'unique',type:'boolean',default:false}]};
const before=JSON.stringify({game,cards}),built=buildCardFieldSetup(game,cards,setup);
assert.deepEqual(built.errors,[]);assert.equal(JSON.stringify({game,cards}),before);
assert.equal(built.cards[0].attributes.health,5);assert.equal(built.cards[1].attributes.health,undefined);
assert.equal(built.cards[0].attributes.cost,0);assert.equal(built.cards[1].attributes.unique,false);
assert.equal(built.filled.length,3);assert.equal(built.files.length,2);
const again=buildCardFieldSetup(built.game,built.cards,setup);assert.equal(again.filled.length,0);assert.equal(again.changes.length,0);
const bad=structuredClone(setup);delete bad.attribute_definitions[1].default;
assert.match(buildCardFieldSetup(game,cards,bad).errors.join('\n'),/One: Health is required/);
assert.doesNotMatch(buildCardFieldSetup(game,cards,bad).errors.join('\n'),/Two: Health/);
bad.attribute_definitions[1].archived=true;assert.deepEqual(buildCardFieldSetup(game,cards,bad).errors,[]);
assert.throws(()=>buildCardFieldSetup(game,cards,{...setup,attribute_definitions:[]}),/hide it instead/);
assert.match(buildCardFieldSetup(game,cards,{...setup,card_types:['character']}).errors.join('\n'),/spell/);
const changed=structuredClone(setup);changed.attribute_definitions[0].type='boolean';assert.match(buildCardFieldSetup(game,cards,changed).errors.join('\n'),/must be boolean/);
assert.match(cardFieldErrors({attribute_definitions:[{key:'x',type:'boolean',default:'false'}]},[]).join(''),/default must be boolean/);
assert.match(cardFieldErrors({attribute_definitions:[{key:'x',type:'number',choices:[true]}]},[]).join(''),/choice/);
assert.match(cardFieldErrors({attribute_definitions:[{key:'x',type:'integer',minimum:10,maximum:1}]},[]).join(''),/minimum exceeds/);
assert.throws(()=>buildCardFieldSetup(game,cards,{...setup,arbitrary_path:'game.yaml'}),/additional properties/);
assert.throws(()=>buildCardFieldSetup(game,cards,{...setup,attribute_definitions:[...setup.attribute_definitions,{key:'test',type:'string',applies_to:[]}]}),/choose at least one card type/);
const starter=buildCardStarter({...game,card_types:['character'],attribute_definitions:setup.attribute_definitions},{names:['First'],fields:[],size:'poker'});
assert.equal(starter.cards[0].type,'character');assert.equal(starter.cards[0].attributes.health,5);assert.equal(starter.cards[0].attributes.unique,false);assert.deepEqual(starter.game.attribute_definitions,setup.attribute_definitions);
// Both validators agree on conditional requirements, bounds, typed defaults and false values.
const root=resolve(import.meta.dirname,'..'),scratch=mkdtempSync(join(tmpdir(),'forge-card-fields.'));
try{
 cpSync(join(root,'examples/ember'),scratch,{recursive:true});
 const manifest=yaml.load(readFileSync(join(scratch,'game.yaml'),'utf8'));
 manifest.card_types=['ember','ward','tool','figure'];manifest.attribute_definitions.push({key:'health',type:'number',applies_to:['ember'],required:true,default:1.5,minimum:0});
 const rows=JSON.parse(readFileSync(join(scratch,'components/cards.json'),'utf8'));
 manifest.card_types=[...new Set([...manifest.card_types,...rows.map(c=>c.type)])];
 for(const card of rows)if(card.type==='ember')card.attributes.health=1.5;
 const save=()=>{writeFileSync(join(scratch,'game.yaml'),yaml.dump(manifest));writeFileSync(join(scratch,'components/cards.json'),JSON.stringify(rows));};
 const validate=expected=>{for(const [exe,args] of [[process.execPath,['tools/validate.mjs',scratch]],[process.env.FORGE_PYTHON||join(root,'.venv/bin/python'),['tools/validate.py',scratch]]]){const result=spawnSync(exe,args,{cwd:root,encoding:'utf8'});assert.equal(result.status===0,expected,`${exe}\n${result.stdout}\n${result.stderr}`);}};
 save();validate(true);delete rows[0].attributes.health;save();validate(false);
 manifest.attribute_definitions.at(-1).archived=true;save();validate(true);
 rows[0].attributes.health=-1;save();validate(false);
 delete rows[0].attributes.health;manifest.attribute_definitions.at(-1).default='no';save();validate(false);
}finally{rmSync(scratch,{recursive:true,force:true});}
console.log('CARD FIELDS CONTRACT GREEN');
