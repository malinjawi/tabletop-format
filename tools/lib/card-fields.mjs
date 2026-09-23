/** Portable card-input definitions. Archiving changes the form, never stored values. */
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import yaml from 'js-yaml';
const gameSchema = JSON.parse(readFileSync(new URL('../../schemas/game.schema.json', import.meta.url), 'utf8'));
const checkSetup = new Ajv({ allErrors: true, strict: false }).compile({type:'object',additionalProperties:false,
  required:['card_types','attribute_definitions'],properties:{card_types:gameSchema.properties.card_types,
    attribute_definitions:gameSchema.properties.attribute_definitions}});
export const fieldApplies = (def, type) => !def.archived && (!def.applies_to || def.applies_to.includes(type));
export const cardTypes = (game, cards) => game.card_types || [...new Set([...cards.map(card=>card.type), ...Object.keys(game.type_colors||{})])];
export function fieldValueError(def, value) {
  const typed = def.type === 'integer' ? Number.isInteger(value) : def.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === def.type;
  if (!typed) return `must be ${def.type}`;
  if (def.choices?.length && !def.choices.some(choice => choice === value)) return `must be one of ${def.choices.join(', ')}`;
  if (typeof value === 'number' && def.minimum !== undefined && value < def.minimum) return `must be at least ${def.minimum}`;
  if (typeof value === 'number' && def.maximum !== undefined && value > def.maximum) return `must be at most ${def.maximum}`;
  return null;
}
export function cardFieldErrors(game, cards) {
  const errors = [], defs = game.attribute_definitions || [], keys = new Set();
  for (const def of defs) {
    if (keys.has(def.key)) errors.push(`Duplicate field '${def.key}'`);
    keys.add(def.key);
    if (['__proto__','prototype','constructor'].includes(def.key)) errors.push(`Field key '${def.key}' is reserved`);
    if (def.applies_to && game.card_types && def.applies_to.some(type=>!game.card_types.includes(type))) errors.push(`${def.name||def.key}: choose existing card types`);
    if (def.minimum !== undefined && def.maximum !== undefined && def.minimum > def.maximum) errors.push(`${def.name||def.key}: minimum exceeds maximum`);
    if ((def.minimum !== undefined || def.maximum !== undefined) && !['integer','number'].includes(def.type)) errors.push(`${def.name||def.key}: limits require a number field`);
    if (def.choices) for (const choice of def.choices) {
      const issue=fieldValueError({...def,choices:undefined},choice);if(issue)errors.push(`${def.name||def.key}: choice ${JSON.stringify(choice)} ${issue}`);
    }
    if (Object.hasOwn(def,'default')) {const issue=fieldValueError(def,def.default);if(issue)errors.push(`${def.name||def.key}: default ${issue}`);}
  }
  for (const card of cards) {
    if (game.card_types && !game.card_types.includes(card.type)) errors.push(`${card.name||card.id}: card type '${card.type}' is not in setup`);
    for (const def of defs) {
      const value = card.attributes?.[def.key];
      if (value === undefined) {if(def.required && fieldApplies(def,card.type))errors.push(`${card.name||card.id}: ${def.name||def.key} is required`);continue;}
      const issue=fieldValueError(def,value);if(issue)errors.push(`${card.name||card.id}: ${def.name||def.key} ${issue}`);
    }
  }
  return errors;
}
export function buildCardFieldSetup(game, cards, setup) {
  if (!checkSetup(setup)) {
    const issue=checkSetup.errors[0], match=/attribute_definitions\/(\d+)/.exec(issue.instancePath), def=match&&setup?.attribute_definitions?.[Number(match[1])];
    if (def && issue.instancePath.endsWith('/applies_to')) throw new Error(`${def.name||def.key}: choose at least one card type.`);
    if (def && issue.instancePath.endsWith('/choices')) throw new Error(`${def.name||def.key}: enter at least one unique dropdown choice.`);
    throw new Error(`Check card setup: ${new Ajv().errorsText(checkSetup.errors)}`);
  }
  const draft = /** @type {{card_types: string[], attribute_definitions: any[]}} */ (setup);
  if (draft.attribute_definitions.length>100) throw new Error('Use at most 100 custom fields');
  const defs=draft.attribute_definitions, oldDefs=game.attribute_definitions||[];
  for (const old of oldDefs) if(!defs.some(def=>def.key===old.key)) throw new Error(`Keep '${old.name||old.key}' and hide it instead. Existing values and template connections must be preserved.`);
  const nextGame={...game,card_types:draft.card_types,attribute_definitions:defs}, nextCards=structuredClone(cards), filled=[];
  for(const card of nextCards)for(const def of defs)if(fieldApplies(def,card.type)&&Object.hasOwn(def,'default')&&!Object.hasOwn(card.attributes||{},def.key)){
    card.attributes??={};card.attributes[def.key]=def.default;filled.push({card_id:card.id,card_name:card.name,field:def.key,value:def.default});
  }
  const errors=cardFieldErrors(nextGame,nextCards);
  const changes=[];
  if(JSON.stringify(cardTypes(game,cards))!==JSON.stringify(draft.card_types))changes.push({kind:'types',label:'Card types',before:cardTypes(game,cards),after:draft.card_types});
  for(const def of defs){const old=oldDefs.find(d=>d.key===def.key);if(JSON.stringify(old)!==JSON.stringify(def))changes.push({kind:!old?'added':def.archived&&!old.archived?'hidden':'updated',label:def.name||def.key,before:old||null,after:def});}
  if(JSON.stringify(oldDefs.map(d=>d.key))!==JSON.stringify(defs.filter(d=>oldDefs.some(o=>o.key===d.key)).map(d=>d.key)))changes.push({kind:'order',label:'Field order'});
  const files=[{path:'game.yaml',content:yaml.dump(nextGame,{noRefs:true,lineWidth:-1})}];
  if(filled.length)files.push({path:'components/cards.json',content:JSON.stringify(nextCards,null,2)+'\n'});
  return {game:nextGame,cards:nextCards,setup,changes,filled,errors,files};
}
