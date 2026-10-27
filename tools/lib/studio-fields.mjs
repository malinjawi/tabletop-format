/** Additive field setup and family-owned placement for the integrated workspace.
 * Runs only inside a disposable exact-revision candidate. Existing regions and
 * field definitions cannot be replaced through this extension. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import yaml from 'js-yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { buildCardFieldSetup, cardTypes } from './card-fields.mjs';
import { currentNandeckSources } from './nandeck-layout.mjs';
import { CARD_DESIGN_MANIFEST } from './card-design.mjs';
const schema=JSON.parse(readFileSync(new URL('../../schemas/layout.schema.json',import.meta.url),'utf8'));
const checkRegion=new Ajv2020({strict:false,allErrors:true}).compile({$defs:schema.$defs,$ref:'#/$defs/region'});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function studioSetup(game,cards){return structuredClone({card_types:cardTypes(game,cards),attribute_definitions:game.attribute_definitions||[]});}
export function buildStudioFields(dir,cards,workspace){
  if(!workspace||typeof workspace!=='object'||Array.isArray(workspace)||Object.keys(workspace).some(key=>!['family','setup','regions'].includes(key)))throw new Error('Invalid workspace field candidate');
  const game=yaml.load(readFileSync(join(dir,'game.yaml'),'utf8'));
  const sources=currentNandeckSources(dir),family=sources.families.find(item=>item.id===workspace.family);
  if(!family)throw new Error('Choose an existing card family');
  const setup=workspace.setup||studioSetup(game,cards),before=studioSetup(game,cards);
  if(!equal(setup.card_types,before.card_types))throw new Error('Change card types in Card setup');
  for(let i=0;i<before.attribute_definitions.length;i++)if(!equal(before.attribute_definitions[i],setup.attribute_definitions?.[i]))throw new Error('Existing fields must be preserved; use Card setup to change them');
  const built=buildCardFieldSetup(game,cards,setup);
  if(built.filled.length)throw new Error('Workspace values belong to individual cards; use Card setup for defaults');
  if(built.errors.length)throw new Error(built.errors.slice(0,5).join('; '));
  const files=[],changes=[];
  if(!equal(setup,before)){
    const doc=parseDocument(readFileSync(join(dir,'game.yaml'),'utf8'));
    doc.set('attribute_definitions',setup.attribute_definitions);
    if(!game.card_types)doc.set('card_types',setup.card_types);
    files.push({path:'game.yaml',content:String(doc)});
  }
  const regions=workspace.regions||[];
  if(!Array.isArray(regions)||regions.length>100)throw new Error('Use at most 100 new card elements');
  if(regions.length){
    // currentNandeckSources has already validated all manifest paths.
    const path=family.source||(existsSync(join(dir,'templates/layout.yaml'))?'templates/layout.yaml':null);
    if(!path)throw new Error('Create a card template before placing fields');
    if(sources.families.some(other=>other.id!==family.id&&other.source===path))throw new Error('This family shares its source file; separate it before adding a field');
    const doc=parseDocument(readFileSync(join(dir,path),'utf8'));
    const ids=new Set(sources.families.flatMap(item=>item.layout.regions.map(region=>region.id)));
    for(const candidate of regions){
      if(!checkRegion(candidate))throw new Error('Invalid field placement: '+JSON.stringify(checkRegion.errors[0]));
      const region=/** @type {any} */(candidate);
      if(!/^[a-z][a-z0-9_-]{0,79}$/.test(region.id)||ids.has(region.id))throw new Error('New card elements need unique stable IDs');
      if(!['text','richtext','badge'].includes(region.type))throw new Error('Place fields as text or a number badge');
      const bindings=String(region.src||'').match(/card\.attributes\.([a-zA-Z0-9_-]+)/g)||[];
      if(bindings.length!==1||!setup.attribute_definitions.some(def=>'card.attributes.'+def.key===bindings[0]&&!def.archived))throw new Error('Connect the element to one active declared field');
      const w=region.d??region.w,h=region.d??region.h;
      if(![region.x,region.y,w,h].every(Number.isFinite)||region.x<0||region.y<0||w<=0||h<=0||region.x+w>family.layout.card.w_mm+.01||region.y+h>family.layout.card.h_mm+.01)throw new Error('Keep new fields inside the card');
      ids.add(region.id);doc.addIn(['regions'],region);
      changes.push({id:region.id,path:'new field placement',before:null,after:region,source_file:path});
    }
    files.push({path,content:String(doc)});
    // Explicit paint order keeps the canvas and every export identical, even
    // when a project's previous manifest did not list its unranked regions.
    if(existsSync(join(dir,CARD_DESIGN_MANIFEST))){
      const manifest=parseDocument(readFileSync(join(dir,CARD_DESIGN_MANIFEST),'utf8'));
      const order=manifest.toJS().region_order||[];
      const all=[...order];
      for(const id of [...new Set(sources.families.flatMap(item=>item.layout.regions.map(region=>region.id)))].sort((a,b)=>a.localeCompare(b)))if(!all.includes(id))all.push(id);
      for(const region of regions)all.push(region.id);
      manifest.set('region_order',all);files.push({path:CARD_DESIGN_MANIFEST,content:String(manifest)});
    }
  }
  return{files,changes,setup_changes:built.changes,family:family.id};
}
