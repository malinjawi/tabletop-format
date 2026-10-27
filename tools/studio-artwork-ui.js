// Artwork choices remain separate from the recoverable Studio draft until Use.
// Saving still goes through the existing exact-candidate Studio protocol.
{const style=document.createElement('style');style.textContent=`
.forge-art-workspace{font-size:13px;line-height:1.5}.forge-art-workspace h3{font-size:18px;margin:0 0 8px}.forge-art-workspace p{color:#bdc5cf;margin:8px 0 14px}.forge-art-workspace .btn{min-height:38px;font-size:12px}.forge-art-workspace input,.forge-art-workspace select{width:100%;box-sizing:border-box;min-height:38px}.forge-art-workspace label{display:block;margin:12px 0 6px}.forge-art-workspace .forge-art-library{grid-template-columns:repeat(2,minmax(0,1fr));max-height:280px}.forge-art-workspace .forge-art-item{background:#292e36;color:#e4e7eb;border-color:#515965;cursor:pointer}.forge-art-workspace .forge-art-item small{color:#c0c8d2}.forge-art-workspace .forge-art-item[data-selected=true]{border-color:#e4e7eb}.forge-art-workspace .forge-art-item img{display:block}.forge-art-workspace .forge-art-thumb{height:130px}.forge-art-workspace .forge-art-scope{background:#30363f;border-radius:7px;padding:10px;margin:12px 0}.forge-art-workspace .forge-art-actions{display:flex;flex-wrap:wrap}.forge-art-workspace .forge-art-actions .btn{flex:1}.forge-art-workspace details{margin:16px 0}.forge-art-workspace summary{cursor:pointer}.forge-art-workspace [role=alert]{color:#ffb4aa}.forge-art-review-select{margin:12px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.forge-art-review-select select{max-width:100%;padding:9px}.forge-art-review-note{font-size:13px;line-height:1.5;margin:12px 0}.forge-art-workspace .forge-art-crop label{font-size:12px!important}.forge-art-workspace .forge-art-crop input{min-height:32px}.forge-studio-panel-tabs{flex-wrap:wrap}
`;document.head.append(style);}

function desArtworkChoice(){const choice=DES?._artChoice;return choice&&choice.card===DES.sel&&choice.printing===desSelectedPrinting()?.id?choice:null;}
function desArtworkCancel(render=true){
  const choice=DES?._artChoice;if(choice?.asset)URL.revokeObjectURL(choice.asset.preview_url);
  if(DES){DES._artChoice=null;DES._artLibraryOpen=false;DES._artUploadIntent=null;}
  if(render){desRenderFull();}
}
function desArtworkOpen(){
  if(!DES?.family||!desSelectedPrinting())return;
  desArtworkCancel(false);DES.rightTab='artwork';DES.compare=false;DES.selRegion=null;DES.selRegions=[];DES._artLibraryOpen=true;
  desRenderFull();void desArtworkLoad();
}
async function desArtworkLoad(){
  const state=DES,route=location.hash;state._artLibraryLoading=true;state._artLibraryError='';desRenderInspectorOnly();
  try{await desLoadArtItems(state);}catch(error){if(DES===state)state._artLibraryError=error.message||'Could not load artwork.';}
  finally{state._artLibraryLoading=false;if(DES===state&&location.hash===route&&state._artLibraryOpen)desRenderInspectorOnly();}
}
function desArtworkChoose(encoded){
  const path=decodeURIComponent(encoded),item=DES.assetItems?.find(item=>item.path===path),printing=desSelectedPrinting();
  if(!item||!printing)return;
  const credits=item.rights?.copyright,creator=item.creator||(Array.isArray(credits)?credits.join(', '):credits)||'';
  const candidate={...printing};
  if(printing.art!==path){
    candidate.art=path;candidate.artist=creator;delete candidate.provenance;
    if(creator&&item.rights?.license)candidate.provenance={source:item.rights.status==='generated'?'ai':'human',creator,license:item.rights.license};
  }
  desArtworkSetChoice(candidate,null);
}
function desArtworkSetChoice(printing,asset){
  DES._artUploadIntent=null;
  const old=DES._artChoice;if(old?.asset&&old.asset!==asset)URL.revokeObjectURL(old.asset.preview_url);
  DES._artChoice={card:DES.sel,printing:printing.id,value:structuredClone(printing),asset,status:'loading'};
  DES.compare=false;DES_REVIEW=null;desRenderCanvasOnly();desRenderInspectorOnly();
}
function desArtworkPreviewPrinting(printing){
  const choice=desArtworkChoice();if(!choice||DES.compare||printing?.id!==choice.printing)return printing;
  const asset=choice.asset||DES.pendingAssets?.[choice.value.art];
  return {...choice.value,art_data:asset?.preview_url||desArtPreviewUrl(choice.value)};
}
async function desArtworkPaint(host){
  const state=DES,choice=desArtworkChoice();
  if(choice){choice.status='loading';desArtworkChoiceStatus();}
  await cardPaintReady(host);
  if(DES!==state||choice!==desArtworkChoice()||!choice||!host?.isConnected)return;
  // Only the latest complete canvas may authorize Use artwork.
  if(document.querySelector('#des-stage-inner .des-cardhost')!==host)return;
  choice.status=!state.compare&&host.dataset.cardState==='ready'?'ready':'error';desArtworkChoiceStatus();
}
function desArtworkChoiceStatus(){
  const choice=desArtworkChoice(),button=document.getElementById('des-artwork-use'),status=document.getElementById('des-artwork-status');
  if(button)button.disabled=choice?.status!=='ready';
  if(status)status.innerHTML=choice?.status==='ready'?'Preview ready. Use artwork to add it to your draft.':choice?.status==='error'?'The preview could not finish. Your draft is unchanged. <button class="btn" onclick="desArtworkRetry()">Retry artwork preview</button>':'Preparing the complete card preview…';
}
function desArtworkRetry(){const choice=desArtworkChoice();if(choice){choice.status='loading';desArtworkChoiceStatus();desRenderCanvasOnly();}}
function desArtworkCrop(key,value){
  const choice=desArtworkChoice();if(!choice){desCropSet(key,value);const output=document.getElementById('des-artwork-'+key);if(output)output.textContent=key==='zoom'?Number(value).toFixed(2)+'×':Math.round(Number(value)*100)+'%';return;}
  choice.value.art_crop??={fit:'cover',focal_x:.5,focal_y:.5,zoom:1};choice.value.art_crop[key]=key==='fit'?value:Number(value);choice.status='loading';
  const output=document.getElementById('des-artwork-'+key);if(output)output.textContent=key==='zoom'?Number(value).toFixed(2)+'×':Math.round(Number(value)*100)+'%';
  desArtworkChoiceStatus();desRenderCanvasOnly();
}
function desArtworkResetCrop(){const choice=desArtworkChoice();if(choice){delete choice.value.art_crop;choice.status='loading';desRenderCanvasOnly();desRenderInspectorOnly();}else desCropReset();}
function desArtworkUse(){
  const choice=desArtworkChoice();if(!choice||choice.status!=='ready'||DES.compare)return;
  const printing=desSelectedPrinting(),previous=printing.art;
  // No other card values, printing metadata, or family layout are replaced.
  for(const key of ['art','art_crop','artist','provenance']){if(Object.hasOwn(choice.value,key))printing[key]=structuredClone(choice.value[key]);else delete printing[key];}
  if(choice.asset){DES.pendingAssets??={};DES.pendingAssets[choice.asset.path]=choice.asset;choice.asset=null;DES.assetItems=null;}
  DES._artChoice=null;DES._artLibraryOpen=false;DES_REVIEW=null;
  if(previous!==printing.art)desArtReleaseIfUnused(previous);
  desRenderFull();toast('Artwork added to this printing’s draft. Review changes to save.',4500);
}
function desArtworkCropHtml(printing){
  const crop=printing.art_crop||{fit:'cover',focal_x:.5,focal_y:.5,zoom:1};
  return `<label>Fit<select aria-label="Artwork fit" onchange="desArtworkCrop('fit',this.value)"><option value="cover" ${crop.fit!=='contain'?'selected':''}>Fill frame</option><option value="contain" ${crop.fit==='contain'?'selected':''}>Show whole image</option></select></label>${[['zoom','Zoom',1,4,.05],['focal_x','Horizontal position',0,1,.01],['focal_y','Vertical position',0,1,.01]].map(([key,label,min,max,step])=>`<label>${label} <output id="des-artwork-${key}">${key==='zoom'?Number(crop[key]??1).toFixed(2)+'×':Math.round((crop[key]??.5)*100)+'%'}</output><input aria-label="Artwork ${label.toLowerCase()}" type="range" min="${min}" max="${max}" step="${step}" value="${crop[key]??(key==='zoom'?1:.5)}" oninput="desArtworkCrop('${key}',this.value)"></label>`).join('')}<button class="btn" onclick="desArtworkResetCrop()">Reset crop</button>`;
}
function desArtworkFilter(query){DES.artQuery=query;const host=document.getElementById('des-artwork-results');if(host)host.innerHTML=desArtworkResults();}
function desArtworkResults(){
  if(DES._artLibraryLoading)return '<div role="status">Loading artwork…</div>'+assetSkeletons(4);
  if(DES._artLibraryError)return `<div role="alert">${esc(DES._artLibraryError)} <button class="btn" onclick="desArtworkLoad()">Retry library</button></div>`;
  const query=(DES.artQuery||'').toLowerCase(),all=DES.assetItems||[],matches=all.filter(item=>`${item.name} ${item.path} ${(item.tags||[]).join(' ')}`.toLowerCase().includes(query));
  if(!matches.length)return `<p role="status">${all.length?'No artwork matches this search.':'No reusable artwork yet. Upload an image to get started.'}</p>`;
  return `<div class="forge-art-library">${matches.slice(0,60).map(item=>`<article class="forge-art-item" data-selected="${desArtworkChoice()?.value.art===item.path}">${assetImage(item.url,item.name,'forge-art-image')}<b>${esc(item.name)}</b><small>${esc(item.rights?.license||'Rights not recorded')}</small><button class="btn" style="width:100%;margin-top:8px" aria-label="Preview ${desAttr(item.name)}" aria-pressed="${desArtworkChoice()?.value.art===item.path}" onclick="desArtworkChoose('${desAttr(encodeURIComponent(item.path).replaceAll("'",'%27'))}')">Preview artwork</button></article>`).join('')}</div>${matches.length>60?'<p>Showing 60 images. Refine your search to find more.</p>':''}`;
}
function desArtworkInspectorHtml(){
  const card=desCard(),printing=desSelectedPrinting();if(!printing)return desPrintingInspectorHtml(G(DES.slug),card);
  const choice=desArtworkChoice(),shown=choice?.value||printing,asset=choice?.asset||DES.pendingAssets?.[shown.art],url=asset?.preview_url||desArtPreviewUrl(shown);
  const scope=`<div class="forge-art-scope"><b>${esc(card.name)}</b><br>Printing ${esc(printing.collector_number||printing.variant||printing.id)} only. Other printings and the shared layout stay unchanged.</div>`;
  if(DES._artLibraryOpen)return `<section class="forge-art-workspace"><div class="forge-art-head"><h3>Choose artwork</h3><button class="btn" onclick="desArtworkCancel()">Cancel</button></div>${scope}<button class="btn primary" onclick="desArtworkUpload()">Upload image</button><label>Find artwork<input type="search" aria-label="Find artwork" value="${desAttr(DES.artQuery||'')}" oninput="desArtworkFilter(this.value)" placeholder="Search name or tag"></label><div id="des-artwork-results">${desArtworkResults()}</div>${choice?`<p>Artist / credit: <b>${esc(shown.artist||'Not recorded')}</b></p>${desArtworkCropHtml(shown)}<p id="des-artwork-status" role="status">${choice.status==='ready'?'Preview ready. Use artwork to add it to your draft.':choice.status==='error'?'The preview could not finish. <button class="btn" onclick="desArtworkRetry()">Retry artwork preview</button>':'Preparing the complete card preview…'}</p><button class="btn primary" id="des-artwork-use" ${choice.status==='ready'?'':'disabled'} onclick="desArtworkUse()">Use artwork</button>`:''}</section>`;
  return `<section class="forge-art-workspace"><h3>Artwork</h3>${scope}<div class="forge-art-thumb">${url?assetImage(url,'Current artwork','',true):'No separate artwork assigned'}</div><p>${esc(printing.artist||'No artist credit recorded')}</p>${asset?'<p>New image staged locally. Credit and rights are included in review.</p>':''}<div class="forge-art-actions"><button class="btn primary" onclick="desArtworkOpen()">Change artwork</button></div>${printing.art?desArtworkCropHtml(printing):'<p>The existing printed face stays intact until you assign artwork.</p>'}<details ${DES._artAdvanced?'open':''} ontoggle="if(this.isConnected&&DES)DES._artAdvanced=this.open"><summary>Printing details & advanced artwork</summary>${desPrintingInspectorHtml(G(DES.slug),card)}</details></section>`;
}
async function desArtworkUpload(){
  const state=DES,route=location.hash,printing=desSelectedPrinting(),card=desCard(),intent=Symbol();if(!printing||!card)return;
  state._artUploadIntent=intent;const current=()=>DES===state&&location.hash===route&&state._artUploadIntent===intent&&state._artLibraryOpen&&desSelectedPrinting()?.id===printing.id;
  const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/svg+xml';
  input.onchange=async()=>{const file=input.files?.[0];if(!file||!current())return;
    let preview_url;
    try{if(file.size>10*1024*1024)throw Error('Use an image smaller than 10 MB.');const extension=file.name.split('.').pop().toLowerCase().replace('jpeg','jpg');if(!['png','jpg','webp','svg'].includes(extension))throw Error('Use PNG, JPG, WebP, or safe SVG.');
      const rights=await assetRightsForm('Credit the art for '+card.name,{creator:ME?.handle||'',license:G(state.slug)?.license||'CC-BY-4.0',status:'original',redistribution:'allowed'});if(!rights||!current())return;
      const bytes=await file.arrayBuffer();if(!current())return;
      const path=`assets/card-art/${card.id}-${crypto.randomUUID()}.${extension}`;preview_url=URL.createObjectURL(file);
      const asset={path,content_base64:desBytesBase64(bytes),preview_url,creator:rights.creator,license:rights.license,status:rights.status,redistribution:rights.redistribution,source:rights.source||undefined,size:file.size};
      desArtworkSetChoice({...printing,art:path,artist:rights.creator,provenance:{source:rights.status==='generated'?'ai':'human',creator:rights.creator,license:rights.license}},asset);
    }catch(error){if(preview_url)URL.revokeObjectURL(preview_url);if(current())toast(esc(error.message),7000);}
  };input.click();
}

function desArtworkReviewOptions(data){
  const printingIds=new Set([...(data.printing_changes?.added||[]),...(data.printing_changes?.changed||[]),...(data.printing_changes?.removed||[])]),cardIds=new Set((data.card_changes||[]).map(change=>change.card));
  if(data.layout_changes?.length||data.setup_changes?.length)desFamilyCards(G(DES.slug)).forEach(card=>cardIds.add(card.id));
  const options=[];for(const p of [...DES.printings,...DES.origPrintings])if(printingIds.has(p.id)&&!options.some(item=>item.printing===p.id))options.push({card:p.card_id,printing:p.id});
  for(const id of cardIds)if(!options.some(item=>item.card===id))options.push({card:id,printing:desSelectedPrinting(DES.cards.find(card=>card.id===id))?.id});
  if(!options.length)options.push({card:DES.sel,printing:desSelectedPrinting()?.id});return options;
}
function desArtworkReviewSelect(index){DES._artReviewIndex=Number(index);document.getElementById('des-art-review-pair').innerHTML=desArtworkReviewPair(DES_REVIEW.data);desArtworkReviewPaint();}
function desArtworkReviewPair(data){
  const options=desArtworkReviewOptions(data),chosen=options[DES._artReviewIndex]||options[0],before=DES.origCards.find(card=>card.id===chosen.card),after=DES.cards.find(card=>card.id===chosen.card);
  const render=(card,original)=>{if(!card)return '<p>This card is '+(original?'new':'removed')+'.</p>';
    const g=G(DES.slug),family=g.card_design?.families?.find(family=>cardDesignMatch(card,family.match)),layout=family?.id===DES.family.id?(original?DES.orig:DES.layout):family?.layout||DES.layout;
    const printing=(original?DES.origPrintings:desPreviewPrintings()).find(p=>p.id===chosen.printing);
    if(!printing)return '<p>This printing is '+(original?'new':'removed')+'.</p>';
    const game={...g,layout,card_design:null,printings:[printing]};return layoutCard(game,card,printing,{w:260,sourceBacked:false});};
  const printing=DES.printings.find(p=>p.id===chosen.printing),crop=printing?.art_crop;
  return `<p class="forge-art-review-note">${esc(after?.name||before?.name||chosen.card)} · Artist: ${esc(printing?.artist||"Not recorded")}${crop?` · Crop: ${Number(crop.zoom??1).toFixed(2)}×`:""}</p><div class="forge-studio-review"><div><h3>Saved version</h3><div class="forge-studio-review-card">${render(before,true)}</div></div><div><h3>After this save</h3><div class="forge-studio-review-card">${render(after,false)}</div></div></div>`;
}
function desArtworkReviewHtml(data){
  const options=desArtworkReviewOptions(data);DES._artReviewIndex=0;
  return `<div class="forge-art-review-select"><label for="des-art-review-card">Compare card / printing</label><select id="des-art-review-card" onchange="desArtworkReviewSelect(this.value)">${options.map((item,index)=>`<option value="${index}">${esc((DES.cards.find(card=>card.id===item.card)||DES.origCards.find(card=>card.id===item.card))?.name||item.card)} · ${esc(item.printing||'No printing')}</option>`).join('')}</select></div><div id="des-art-review-pair">${desArtworkReviewPair(data)}</div>`;
}
function desArtworkReviewPaint(){document.querySelectorAll('#des-art-review-pair .forge-studio-review-card').forEach(host=>void cardPaintReady(host));}
async function desOpenCardArtwork(slug,id){
  const route=location.hash,g=G(slug),card=g?.cards.find(card=>card.id===id),family=g?.card_design?.families?.find(family=>cardDesignMatch(card,family.match));if(!family){openEditor(slug,id);return;}
  document.getElementById('modal').classList.remove('on');await designFamilyEdit(slug,family.id,id);
  if(location.hash===route&&DES?.slug===slug&&DES.sel===id&&!DES_DRAFT_OFFER){DES.rightTab='artwork';desRenderFull();}
}
