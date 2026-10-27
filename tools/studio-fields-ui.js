// Loaded only when Studio opens. Uses its existing renderer and reviewed save.
{const style=document.createElement("style");style.textContent="/* Integrated workspace: neutral tools, unchanged card artwork. */\n.forge-studio .btn.primary{background:#e4e7eb;border-color:#c8cdd4;color:#20252c}.forge-studio .btn.primary:hover{background:#fff}\n.forge-studio .des-field.on,.forge-studio-impact-card.on{background:#353b43;border-color:#9ba6b4}\n.forge-studio .des-box.sel{border-color:#dde3ec;background:#cad4e61a;box-shadow:0 0 0 2px #bfcadb66}.forge-studio .des-tag{background:#303c49}.forge-studio .des-h{border-color:#8e9cad}\n.forge-studio-grid{grid-template-columns:190px minmax(320px,1fr) 330px}.forge-studio-workarea{background-image:none;background-color:#191c21}\n.forge-field-add{width:100%;margin-bottom:16px;min-height:40px}.forge-field-composer{font-size:13px;line-height:1.5}.forge-field-composer h3{font-size:19px;margin:0 0 8px}.forge-field-composer p{color:#bcc3cd;margin:8px 0 14px}.forge-field-composer .fld label{font-size:13px;color:#e0e4eb}.forge-field-composer small{display:block;color:#aeb7c5;margin-top:6px}.forge-field-composer input,.forge-field-composer select{min-height:42px;width:100%;box-sizing:border-box}\n.forge-field-composer details{padding:12px 0;border-top:1px solid #454b55;border-bottom:1px solid #454b55;margin:16px 0}.forge-field-composer details .fld{margin-top:14px}.forge-field-impact{padding:12px;background:#2c3037;border-radius:7px;margin:16px 0}.forge-field-impact p{margin:6px 0 0}.forge-field-check{display:flex;gap:10px;align-items:center}.forge-field-check input{width:18px;min-height:18px;height:18px}.forge-field-actions,.forge-field-positions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.forge-field-actions .btn{min-height:44px;flex:1}.forge-field-positions .btn{min-height:38px}.forge-workspace-field{padding:12px 0;border-top:1px solid #3e454f}.forge-workspace-field .card-field-group legend{display:none}.forge-workspace-field .card-field-group{border:0;padding:0;margin:0}.forge-workspace-field .btn{font-size:11px;min-height:32px}.forge-studio #des-inspector{height:670px}\n@media(max-width:1100px) and (min-width:761px){.forge-studio-grid{grid-template-columns:150px minmax(250px,1fr)}.forge-studio-right{grid-column:1/-1}.forge-studio #des-inspector{height:auto;max-height:none}}\n@media(max-width:760px){.forge-studio-grid{grid-template-columns:minmax(0,1fr)}.forge-studio #des-inspector{height:auto;max-height:none}.forge-field-composer{font-size:14px}.forge-field-composer .btn{min-height:44px}}\n";document.head.append(style);}
function desNewField(){
  if(!DES?.access?.canWrite||!DES.setup)return;
  if(DES.fieldDraft)return;
  const key='field_'+Date.now().toString(36),card=desCard();
  DES.fieldDraft={key,new:true,name:'',type:'number',cardType:card.type,scope:'type',show:true,regionId:null,
    before:structuredClone({layout:DES.layout,cards:DES.cards,setup:DES.setup,undo:DES.undo})};
  DES.setup.attribute_definitions.push({key,name:'New field',type:'number',applies_to:[card.type]});
  DES.undo=[];DES.face='front';DES.compare=false;DES.rightTab='content';DES_REVIEW=null;
  desFieldSync();desRenderFull();document.getElementById('des-field-name')?.focus();
}
function desConnectField(key){
  if(DES.fieldDraft||!DES.access?.canWrite)return;
  const def=desDefinitions().find(item=>item.key===key);if(!def)return;
  const existing=desFieldBindings(key)[0];
  DES.fieldDraft={key,new:false,name:def.name||key,type:def.type,cardType:desCard().type,scope:def.applies_to?'type':'all',show:true,regionId:existing?.id||null,
    before:structuredClone({layout:DES.layout,cards:DES.cards,setup:DES.setup,undo:DES.undo})};
  DES.undo=[];DES.face='front';DES.compare=false;DES_REVIEW=null;desFieldSync();desRenderFull();
}
function desFieldSync(){
  const draft=DES.fieldDraft;if(!draft)return;
  const def=desDefinitions().find(item=>item.key===draft.key);
  if(draft.new){def.name=draft.name.trim()||'New field';def.type=draft.type;if(draft.scope==='all')delete def.applies_to;else def.applies_to=[draft.cardType];}
  if(draft.show){
    let region=DES.layout.regions.find(item=>item.id===draft.regionId);
    if(!region&&draft.hiddenRegion){region=structuredClone(draft.hiddenRegion);DES.layout.regions.push(region);draft.regionId=region.id;delete draft.hiddenRegion;}
    if(!region){
      draft.regionId=desUniqueId(('field_'+desSlug(DES.family.id)+'_'+draft.key).slice(0,70));
      const card=DES.layout.card,W=card.w_mm,H=card.h_mm;
      region={id:draft.regionId,type:'richtext',src:'card.attributes.'+draft.key,x:round2(Math.max(0,W-22)),y:round2(Math.max(0,H*.28)),w:Math.min(19,W),h:Math.min(12,H*.5),
        size_pt:9,min_size_pt:6,autoshrink:true,align:'center',valign:'middle',color:'#20252c',bg:'#f5f1e8',border:{color:'#30353e',width_mm:.3,style:'solid'}};
      const font=DES.layout.fonts?.[0]?.id;if(font)region.font=font;
      DES.layout.regions.push(region);draft.createdRegion=true;
    }
    if(draft.createdRegion){region.src=(draft.name.trim()||'New field')+'\n{card.attributes.'+draft.key+'}';
      const types=def.applies_to;
      if(types?.length)region.show_if=types.map(type=>'type == '+type).join(' || ');else delete region.show_if;
    }
    DES.selRegion=region.id;DES.selRegions=[region.id];
  }else if(draft.createdRegion){draft.hiddenRegion=structuredClone(DES.layout.regions.find(item=>item.id===draft.regionId)||draft.hiddenRegion);DES.layout.regions=DES.layout.regions.filter(item=>item.id!==draft.regionId);DES.selRegion=null;DES.selRegions=[];draft.regionId=null;}
  draft.review=false;DES_REVIEW=null;DES.compare=false;desRenderCanvasOnly();desRefreshStudioChrome();desFieldImpactRefresh();
}
function desFieldImpactRefresh(){
  clearTimeout(DES?._fieldImpactTimer);const state=DES;
  state._fieldImpactTimer=setTimeout(()=>{if(DES!==state)return;const host=document.querySelector('.forge-studio-impact');if(host){const scroll=host.querySelector('.forge-studio-impact-strip')?.scrollLeft||0;host.outerHTML=desStudioImpactHtml(G(DES.slug));const strip=document.querySelector('.forge-studio-impact-strip');if(strip)strip.scrollLeft=scroll;}},180);
}
function desFieldName(value){DES.fieldDraft.name=value;desFieldSync();}
function desFieldOptions(prop,value){
  const draft=DES.fieldDraft;
  if(prop==='type'&&value!==draft.type&&DES.cards.some(card=>Object.hasOwn(card.attributes||{},draft.key))){toast('Clear this field’s draft values before changing its type.');desRenderInspectorOnly();return;}
  draft[prop]=value;desFieldSync();desRenderInspectorOnly();
}
function desFieldValue(value){const draft=DES.fieldDraft;desContentSet('attributes.'+draft.key,value,['number','integer'].includes(draft.type)?'number':draft.type);draft.review=false;DES_REVIEW=null;desFieldImpactRefresh();}
function desFieldPosition(position){
  const draft=DES.fieldDraft,region=desRegion(draft?.regionId);if(!region)return;
  const pre=desBeginChange(),W=DES.layout.card.w_mm,H=DES.layout.card.h_mm,w=region.d??region.w,h=region.d??region.h;
  region.x=round2(position==='left'?3:position==='right'?W-w-3:(W-w)/2);region.y=round2(position==='bottom'?H-h-5:H*.28);
  region.x=clamp(region.x,0,W-w);region.y=clamp(region.y,0,H-h);desCommitChange(pre);desRenderCanvasOnly();desRenderInspectorOnly();
}
function desFieldCancel(){
  const draft=DES.fieldDraft;if(!draft)return;
  // Roll back this field only. Unrelated artwork/card edits stay in the draft.
  if(draft.new)DES.setup.attribute_definitions=DES.setup.attribute_definitions.filter(def=>def.key!==draft.key);
  const oldCards=new Map(draft.before.cards.map(card=>[card.id,card]));
  for(const card of DES.cards){const attrs=oldCards.get(card.id)?.attributes||{};
    if(Object.hasOwn(attrs,draft.key)){card.attributes??={};card.attributes[draft.key]=attrs[draft.key];}
    else if(card.attributes){delete card.attributes[draft.key];if(!Object.keys(card.attributes).length&&!oldCards.get(card.id)?.attributes)delete card.attributes;}}
  if(draft.regionId){const original=draft.before.layout.regions.find(region=>region.id===draft.regionId);
    DES.layout.regions=DES.layout.regions.filter(region=>region.id!==draft.regionId);
    if(original){const index=draft.before.layout.regions.indexOf(original);DES.layout.regions.splice(index,0,structuredClone(original));}}
  DES.fieldDraft=null;DES_REVIEW=null;DES.selRegion=null;DES.selRegions=[];DES.undo=[];DES.rightTab='content';desRenderFull();
}
function desFieldPrepare(){
  const draft=DES.fieldDraft;if(!draft)return true;
  const name=draft.name.trim();
  if(draft.new&&(!name||name.length>60||/[{}\[\]\n\r]/.test(name))){toast('Give the field a short name without braces or line breaks.');document.getElementById('des-field-name')?.focus();return false;}
  if(draft.new){
    const duplicate=desDefinitions().some(def=>def.key!==draft.key&&(def.name||def.key).toLowerCase()===name.toLowerCase());
    if(duplicate){toast('A field with that name already exists. Use its Place on card button.');return false;}
    const base=desSlug(name).slice(0,26),used=new Set([...desDefinitions().filter(def=>def.key!==draft.key).map(def=>def.key),...DES.cards.flatMap(card=>Object.keys(card.attributes||{}).filter(key=>key!==draft.key)), '__proto__','prototype','constructor']);
    let key=base,n=2;while(used.has(key))key=base+'_'+n++;
    if(key!==draft.key){const old=draft.key,def=desDefinitions().find(item=>item.key===old);def.key=key;
      for(const card of DES.cards)if(Object.hasOwn(card.attributes||{},old)){card.attributes[key]=card.attributes[old];delete card.attributes[old];}
      const region=DES.layout.regions.find(item=>item.id===draft.regionId);if(region)region.src=region.src.replaceAll('card.attributes.'+old,'card.attributes.'+key);if(draft.hiddenRegion)draft.hiddenRegion.src=draft.hiddenRegion.src.replaceAll('card.attributes.'+old,'card.attributes.'+key);
      draft.key=key;DES.undo=[];}
  }
  return true;
}
async function desFieldReview(){if(!desFieldPrepare())return;try{await desStudioDryRun(true);}catch(error){toast(esc(error.message),7000);}}
function desFieldKeepEditing(){if(DES.fieldDraft)DES.fieldDraft.review=false;DES_REVIEW=null;desRenderInspectorOnly();}
function desFieldScopeText(){
  const draft=DES.fieldDraft,region=DES.layout.regions.find(item=>item.id===draft?.regionId);
  if(!draft?.show)return 'Kept in card data only.';
  if(!draft.createdRegion&&region){const origin=DES.family.origins?.[region.id];
    if(origin&&origin!==DES.family.source)return 'This existing element is shared with other templates. Review lists every affected template.';}
  return 'Position belongs to the '+(DES.family.label||DES.family.id)+' template. It appears only on cards that use this field’s card type.';
}
function desFieldPreflightReport(){
  const g=G(DES.slug),blocking=[],inherited=[];
  for(const issue of desFamilyPreflight().filter(item=>item.level==='error')){
    const before=DES.origCards.find(card=>card.id===issue.card),after=DES.cards.find(card=>card.id===issue.card);
    const oldPrinting=desSelectedPrinting(before,true),printing=desSelectedPrinting(after);
    const wasPresent=before&&desCardPreflight(g,before,oldPrinting,DES.orig).some(old=>old.level==='error'&&old.region===issue.region&&old.message===issue.message);
    const original=DES.orig.regions.find(region=>region.id===issue.region),current=DES.layout.regions.find(region=>region.id===issue.region);
    let unchanged=false;
    if(issue.region==='card.text')unchanged=before?.text===after?.text;
    else if(issue.region==='printing.flavor_text')unchanged=oldPrinting?.flavor_text===printing?.flavor_text;
    else if(original&&current&&JSON.stringify(original)===JSON.stringify(current)){
      const value=(region,card,printing,layout)=>{const ctx={card,printing:printing||{},g:{...g,layout},layout,attributes:card?.attributes||{}};return[layValue(ctx,region),region.secondary_src?layStringify(layResolve(ctx,region.secondary_src)):''];};
      unchanged=JSON.stringify(value(original,before,oldPrinting,DES.orig))===JSON.stringify(value(current,after,printing,DES.layout));
    }
    (wasPresent&&unchanged?inherited:blocking).push(issue);
  }
  return{blocking,inherited};
}
function desFieldComposerHtml(){
  const draft=DES.fieldDraft,card=desCard(),def=desDefinitions().find(item=>item.key===draft.key),familyCards=desFamilyCards(G(DES.slug));
  const applies=!def.applies_to||def.applies_to.includes(card.type),available=DES.cards.filter(item=>!def.applies_to||def.applies_to.includes(item.type)).length;
  if(draft.review&&DES_REVIEW){const data=DES_REVIEW.data,fitReport=desFieldPreflightReport(),fitErrors=fitReport.blocking,ready=data.ok&&!fitErrors.length,changed=DES.cards.filter(item=>JSON.stringify(item.attributes?.[draft.key])!==JSON.stringify(draft.before.cards.find(before=>before.id===item.id)?.attributes?.[draft.key]));
    return `<div class="forge-field-composer"><h3>Review ${esc(draft.name)}</h3><p>The preview shows your draft.</p><div class="forge-field-impact"><b>${draft.new?'New field':'Field connection'}</b><p>Available on ${available} cards. ${esc(desFieldScopeText())}</p></div><h4>Values</h4>${changed.length?changed.map(item=>`<p>${esc(item.name)}: <b>${esc(item.attributes?.[draft.key]??'Empty')}</b></p>`).join(''):'<p>No values changed.</p>'}<p>Other cards keep their existing values.</p><details><summary>All changes in this save</summary><p>Templates changed: ${esc((data.affected_families||[]).join(", ")||"None")}</p>${(data.setup_changes||[]).map(change=>`<p>${esc(change.label)} · ${esc(change.kind)}</p>`).join('')}${(data.changed_files||[]).map(path=>`<p>${esc(path)}</p>`).join('')}</details><p role="status">${ready?'Validation passed. Ready to save.':'This draft needs attention before saving.'}</p>${fitErrors.map(issue=>`<p class="warn">${esc(issue.message)}</p>`).join('')}${fitReport.inherited.length?`<details><summary>${fitReport.inherited.length} existing text-fit issue(s), unchanged</summary>${fitReport.inherited.map(issue=>`<p>${esc(DES.cards.find(card=>card.id===issue.card)?.name||issue.card)} · ${esc(issue.message)}</p>`).join('')}<p>This edit does not change that text or its layout. Check it in Proof before printing.</p></details>`:''}${!data.ok?`<div class="warn">${[...(data.conflicts||[]).map(item=>item.path||item.scope),...(data.validation?.report||[]).filter(line=>/error|invalid|✗/i.test(line))].map(esc).join('<br>')}</div>`:''}<div class="forge-field-actions"><button class="btn" onclick="desFieldKeepEditing()">Keep editing</button><button class="btn primary" id="des-studio-commit" ${ready?'':'disabled'} onclick="desStudioCommit()">Save changes</button></div></div>`;
  }
  const value=card.attributes?.[draft.key]??'';
  return `<div class="forge-field-composer"><h3>${draft.new?'Add a field':esc(draft.name)}</h3><p>${draft.new?'Name it, enter a value, and place it on the card.':'Edit this card’s value and its position in this template.'}</p>${draft.new?`<div class="fld"><label for="des-field-name">Field name</label><input id="des-field-name" maxlength="60" placeholder="e.g. Armor" value="${esc(draft.name)}" oninput="desFieldName(this.value)"></div>`:''}<div class="fld"><label for="des-field-value">Value for ${esc(card.name)}</label>${def.choices?.length||def.type==='boolean'?`<select id="des-field-value" ${applies?'':'disabled'} onchange="desFieldValue(this.value)"><option value="">Empty</option>${(def.choices||[true,false]).map(choice=>`<option value="${esc(choice)}" ${String(value)===String(choice)?'selected':''}>${esc(choice)}</option>`).join('')}</select>`:`<input id="des-field-value" type="${['integer','number'].includes(draft.type)?'number':'text'}" step="${draft.type==='integer'?'1':'any'}" value="${esc(value)}" placeholder="Empty" ${applies?'':'disabled'} oninput="desFieldValue(this.value)">`}<small>${applies?'Only this card’s value changes. Select another card to enter its value.':'This field is not available for this card type.'}</small></div>${draft.new?`<label class="forge-field-check"><input type="checkbox" ${draft.show?'checked':''} onchange="desFieldOptions('show',this.checked)"> Show on card</label><details><summary>Field options</summary><div class="fld"><label for="des-field-kind">Value type</label><select id="des-field-kind" onchange="desFieldOptions('type',this.value)"><option value="number" ${draft.type==='number'?'selected':''}>Number</option><option value="string" ${draft.type==='string'?'selected':''}>Text</option></select></div><div class="fld"><label for="des-field-scope">Available on</label><select id="des-field-scope" onchange="desFieldOptions('scope',this.value)"><option value="type" ${draft.scope==='type'?'selected':''}>${esc(draft.cardType)} cards</option><option value="all" ${draft.scope==='all'?'selected':''}>All card types</option></select></div></details>`:''}<div class="forge-field-impact"><b>Available on ${available} cards</b><p>${esc(desFieldScopeText())}</p></div>${draft.show?`<p>Drag the field on the card, or choose a position. Arrow keys make small adjustments.</p><div class="forge-field-positions" role="group" aria-label="Field position"><button class="btn" onclick="desFieldPosition('left')">Left</button><button class="btn" onclick="desFieldPosition('center')">Center</button><button class="btn" onclick="desFieldPosition('right')">Right</button><button class="btn" onclick="desFieldPosition('bottom')">Bottom</button><button class="btn" data-field-undo onclick="desUndo()" ${DES.undo.length?'':'disabled'}>Undo move</button></div>`:''}<div class="forge-field-actions"><button class="btn" onclick="desFieldCancel()">Cancel field</button><button class="btn primary" onclick="desFieldReview()">Review field</button></div></div>`;
}
function desFieldListHtml(card){
  return desDefinitions().filter(def=>!def.archived&&(!def.applies_to||def.applies_to.includes(card.type))).map(def=>{
    const connected=desFieldBindings(def.key).length>0;
    return `<div class="forge-workspace-field">${cardFieldsHtml([def],card,'des-content-attributes-',item=>`desGameFieldSet.bind(null,'${item.key}')`)}${DES.access?.canWrite?`<button class="btn" onclick="desConnectField('${esc(def.key)}')">${connected?'Edit on card':'Place on card'}</button>`:`<small>${connected?'On card':'Card data only'}</small>`}</div>`;
  }).join('');
}


function desPrintingInspectorHtml(g,card){
  const list=(DES.printings||[]).filter(printing=>printing.card_id===card.id),printing=desSelectedPrinting(card);if(!printing)return`<div class="forge-art-panel"><div class="forge-art-head"><b>Production printing</b><button class="btn" onclick="desAddPrinting()">+ Add</button></div><div class="mut" style="font-size:10px">This card has no physical printing yet.</div></div>`;
  const crop=printing.art_crop||{fit:"cover",focal_x:.5,focal_y:.5,zoom:1},artUrl=desArtPreviewUrl(printing),staged=DES.pendingAssets?.[printing.art],sets=(g.sets||[]).map(set=>({value:set.id,label:set.name||set.title||set.id}));
  return `<div class="forge-art-panel"><div class="forge-art-head"><b>Production printing</b><button class="btn" onclick="desAddPrinting()">+ Variant</button></div>${list.length>1?`<div class="fld"><label>Printing<select onchange="desPrintingSelect(this.value)">${list.map(item=>`<option value="${desAttr(item.id)}" ${item.id===printing.id?"selected":""}>${esc(item.variant||item.collector_number||item.id)}</option>`).join("")}</select></label></div>`:""}<div class="mut mono" style="font-size:9px;margin-bottom:8px">${esc(printing.id)}</div>${sets.length?desPrintingControl("Set","set_id",printing.set_id,"string",sets):""}<div class="component-pair">${desPrintingControl("Card number","collector_number",printing.collector_number||"")}${desPrintingControl("Copies","quantity",printing.quantity||1,"number")}</div>${desPrintingControl("Artist / credit","artist",printing.artist||"")}${desPrintingControl("Flavor text","flavor_text",printing.flavor_text||"","longstring")}${desPrintingControl("Variant label","variant",printing.variant||"")}
    <div class="forge-art-head" style="margin-top:12px"><b>Artwork & crop</b>${printing.art_crop?`<button class="btn" onclick="desCropReset()">Reset crop</button>`:""}</div>${staged?`<div class="forge-art-staged">● New file staged · ${(staged.size/1048576).toFixed(2)} MB · rights included in review</div>`:""}<div class="forge-art-thumb">${artUrl?assetImage(artUrl,"Current raw artwork","",true):"No raw artwork assigned"}</div><div class="forge-art-actions"><button class="btn" onclick="desArtLibraryOpen()">Choose library</button><button class="btn" onclick="desArtUpload()">Upload new</button></div>${printing.art?`<div class="forge-art-rights${staged?" ready":""}">${esc(printing.art)}${staged?`<br>${esc(staged.creator)} · ${esc(staged.license)} · ${esc(staged.status)}`:" · existing repository asset"}</div><div class="fld"><label>Fit<select onchange="desCropSet('fit',this.value)"><option value="cover" ${crop.fit!=="contain"?"selected":""}>Fill frame (cover)</option><option value="contain" ${crop.fit==="contain"?"selected":""}>Show whole art (contain)</option></select></label></div><div class="forge-art-crop"><label>Horizontal focus<input type="range" min="0" max="1" step="0.01" value="${crop.focal_x??.5}" oninput="desCropSet('focal_x',this.value)"></label><output id="des-crop-focal_x-out">${Math.round((crop.focal_x??.5)*100)}%</output><label>Vertical focus<input type="range" min="0" max="1" step="0.01" value="${crop.focal_y??.5}" oninput="desCropSet('focal_y',this.value)"></label><output id="des-crop-focal_y-out">${Math.round((crop.focal_y??.5)*100)}%</output><label>Zoom<input type="range" min="1" max="4" step="0.05" value="${crop.zoom??1}" oninput="desCropSet('zoom',this.value)"></label><output id="des-crop-zoom-out">${Number(crop.zoom??1).toFixed(2)}×</output></div><button class="btn" style="width:100%;margin-top:8px;color:#ffaaa4" onclick="desClearArt()">Remove raw-art assignment</button>`:""}</div>`;
}

function desContentInspectorHtml(){
  const g=G(DES.slug),card=desCard();if(!card)return`<div class="forge-studio-empty"><b>No card selected</b>Choose a card from the project list.</div>`;
  let h=`<div class="forge-studio-content-intro"><b>${esc(card.name)}</b>Values belong to this card. Positions are shared by its template.</div>${DES.access?.canWrite&&DES.setup?'<button class="btn primary forge-field-add" onclick="desNewField()">+ Add field</button>':''}`;
  h+=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin:-3px 0 12px"><button class="btn" onclick="desDataTableOpen()">▦ Edit table</button><button class="btn" onclick="desDuplicateCard()">Duplicate</button><button class="btn" style="color:#ffaaa4" onclick="desRemoveCard()">Remove</button></div>`;
  h+=`<div class="mut mono" style="font-size:10px;margin-bottom:10px">${esc(card.id)}${desCardDirty(card.id)?'<span class="forge-studio-dirty-dot" title="Uncommitted card changes"></span>':""}</div>`;
  h+=desContentControl("Name","name",card.name);
  h+=`<div class="fld"><label for="des-content-type">Type · controls this layout family</label><input id="des-content-type" value="${esc(card.type||"")}" disabled><div class="mut" style="font-size:10px;margin-top:4px">Move a card between types in the full Card Data editor so Forge can switch its family explicitly.</div></div>`;
  h+=desContentControl("Subtypes (comma-separated)","subtypes",(card.subtypes||[]).join(", "),"array");
  h+=desRichTextControl("Rules text","text",card.text||"");
  h+=desContentControl("Keywords (comma-separated)","keywords",(card.keywords||[]).join(", "),"array");
  if(card.deck_limit!==undefined)h+=desContentControl("Deck limit","deck_limit",card.deck_limit,"number");
  h+=desFieldListHtml(card);
  h+=desPreflightPanelHtml();
  h+=desPrintingInspectorHtml(g,card);
  h+=`<details class="forge-studio-tech"><summary>Why the ID is locked</summary><code>${esc(card.id)}</code><div style="margin-top:7px">The stable ID anchors history, printings, decks, rulebook references, diffs, and external working copies.</div></details>`;
  return h;
}

function desStudioToolbarHtml(g){
  const dirty=desAnyDirty(),source=String(DES.sourceRef||"").slice(0,8);
  const pnpink=g.design_engines?.engines?.some(engine=>engine.type==="pnpink");
  return `<div class="forge-studio-top"><button class="btn forge-studio-back" onclick="desReopenGallery()" aria-label="Back to all card families" title="Back to all card families">←</button><div class="forge-studio-title"><h2>${esc(g.title)} · ${esc(DES.family.label||DES.family.id)}</h2><span>${esc(desCard()?.name||"")} · base ${esc(source||"working tree")} · ${DES._draftError?"local recovery unavailable":"local recovery on"}</span></div><span class="forge-studio-status${dirty?" dirty":""}" role="status" aria-live="polite" aria-atomic="true">${esc(desDirtyLabel())}</span><div class="forge-studio-actions"><details class="forge-studio-menu"><summary class="btn">Other editors ▾</summary><div class="forge-studio-pop"><button onclick="designExportSquib('${esc(g.slug)}')"><b>Download Squib project</b><small>Runnable Ruby DSL + CSV + declarative layouts</small></button><button onclick="designImportSquib('${esc(g.slug)}')"><b>Return Squib project</b><small>Review CSV and YAML; Forge never runs Ruby</small></button>${pnpink?`<button onclick="designExportPnpink('${esc(g.slug)}')"><b>Download PnPInk projects</b><small>Production working copies for Inkscape</small></button><button onclick="designImportPnpink('${esc(g.slug)}')"><b>Return PnPInk project</b><small>Review card data and SVG source together</small></button>`:""}<button onclick="designExportSvg('${esc(g.slug)}')"><b>Download SVG geometry kit</b><small>Round-trip simple named regions</small></button><button onclick="designImportSvg('${esc(g.slug)}')"><b>Return edited SVG</b><small>Dry-run supported geometry before Git</small></button><button onclick="designExportNandeck('${esc(g.slug)}')"><b>Download nanDECK kit</b><small>Script and committed card data</small></button><button onclick="designImportNandeck('${esc(g.slug)}')"><b>Return nanDECK script</b><small>Review script changes against Forge</small></button><button onclick="designExportProject('${esc(g.slug)}')"><b>Download full Forge project</b><small>Every card, asset, template, and adapter</small></button></div></details><button class="btn" onclick="desDataTableOpen()">Table</button><button class="btn" onclick="designProofOpen('${esc(g.slug)}','${esc(DES.family.id)}')">Proof ${desFamilyCards(g).length}</button><button class="btn primary" id="des-save" onclick="desSave()">Review changes</button></div></div>`;
}

// Keep the completion tied to the reviewed draft, even if editing/navigation
// continues during the request or IndexedDB cleanup.
async function desStudioCommit(){
  if(!DES_REVIEW||DES?._studioSaving)return;
  const review=DES_REVIEW,state=DES,route=location.hash;
  const {review_token,...reviewed}=review.payload, fingerprint=JSON.stringify(reviewed);
  const stillReviewed=()=>DES===state&&location.hash===route&&JSON.stringify(desStudioPayload())===fingerprint;
  if(!stillReviewed()){toast("The draft changed. Review again before saving.");return;}
  if((state.fieldDraft?desFieldPreflightReport().blocking:desFamilyPreflight().filter(issue=>issue.level==="error")).length){toast("Fix the family text-fit errors before committing.",7000);return;}
  const button=document.getElementById("des-studio-commit");
  if(button){button.disabled=true;button.textContent="Validating and committing…";}
  state._studioSaving=true;
  const keepNewerDraft=()=>{if(DES===state)desDraftQueue(0);toast("The reviewed version was saved. Your newer draft has been kept; reopen the saved version before reviewing further changes.",9000);};
  try{
    const response=await fetch(`/api/games/${encodeURIComponent(review.slug)}/design/studio?commit=1`,{method:"POST",headers:{"content-type":"application/json",...authHdr()},body:JSON.stringify(review.payload)}),data=await response.json().catch(()=>({}));
    if(!response.ok){toast(`<b style="color:#ffa198">✗ ${esc(data.error||response.status)}</b>`,8000);return;}
    if(!stillReviewed()){keepNewerDraft();return;}
    await desDraftClearCurrent().catch(()=>{});
    if(!stillReviewed()){keepNewerDraft();return;}
    state._draftReady=false;
    $("#modal").classList.remove("on");toast(data.proposed?`<b>⇡ Pull request opened</b><br>${esc(data.message)} · commit ${esc(String(data.commit||"").slice(0,10))}`:`<b>✓ Committed</b><br>${esc(data.message)} · commit ${esc(String(data.commit||"").slice(0,10))}`,9000);
    if(data.proposed){setTimeout(()=>{if(DES===state&&location.hash===route)openFocusedPr(review.slug,data.pr);},500);}
    else{const saved={slug:state.slug,family:state.family.id,card:state.sel};DES=null;DES_REVIEW=null;await loadProjectView(saved.slug);if(DES===null&&location.hash===route)await designFamilyEdit(saved.slug,saved.family,saved.card);}
  }catch(error){toast(esc(error.message||"Could not save. Your draft is still here."),7000);}
  finally{state._studioSaving=false;if(button){button.disabled=false;button.textContent="Save changes";}}
}
