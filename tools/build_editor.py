#!/usr/bin/env python3
"""build_editor.py - in-browser card editor prototype (Block I), format v0.1.
Usage: python3 tools/build_editor.py <game-dir> [-o out.html]

Emits a SELF-CONTAINED editor: card list, editable fields, LIVE HTML/CSS
card preview (same layout language as the reference renderer - proving R1's
"one template, three outputs" bet), a running semantic diff against the
loaded version, and one-click download of a valid cards.json.
On the platform, "Download" becomes "Save" = one git commit.
"""
import html, json, sys
from pathlib import Path
import yaml

def main():
    args = sys.argv[1:]
    game_dir = Path(args[0])
    out_path = Path(args[args.index("-o") + 1]) if "-o" in args else game_dir / "exports" / "editor.html"

    game = yaml.safe_load((game_dir / "game.yaml").read_text())
    cards = json.loads((game_dir / "components/cards.json").read_text())

    payload = {
        "title": game.get("title", "Untitled"),
        "slug": game.get("id", ""),
        "attribute_definitions": game.get("attribute_definitions") or [],
        "symbols": {s["key"]: s.get("name", s["key"]) for s in (game.get("symbols") or [])},
        "glyphs": {s["key"]: s["glyph"] for s in (game.get("symbols") or []) if s.get("glyph")},
        "type_colors": game.get("type_colors") or {},
        "cards": cards,
    }
    data_js = json.dumps(payload).replace("</", "<\\/")

    page = r"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>__TITLE__ — card editor</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--acc:#8c2f1b;--bg:#f4f1ea;--mut:#777}
*{box-sizing:border-box} body{font-family:-apple-system,'Segoe UI',sans-serif;margin:0;background:var(--bg);color:#1c1c1e}
header{background:var(--acc);color:#fff;padding:14px 24px;display:flex;align-items:center;gap:16px}
header h1{font-size:17px;margin:0;flex:1}
.btn{background:#fff;color:var(--acc);border:none;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer}
.btn.ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.6)}
#wrap{display:grid;grid-template-columns:220px 1fr 340px;gap:0;height:calc(100vh - 58px)}
#list{background:#fff;border-right:1px solid #e2ddd2;overflow-y:auto}
#list button{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid #f0ece3;padding:12px 16px;cursor:pointer;font-size:14px}
#list button.on{background:#fdf3ef;border-left:3px solid var(--acc);font-weight:600}
#list .dirty::after{content:" •";color:var(--acc)}
#form{padding:22px 26px;overflow-y:auto}
#form label{display:block;font-size:12px;text-transform:uppercase;color:var(--mut);margin:14px 0 4px}
#form input,#form textarea{width:100%;padding:9px 12px;border:1px solid #d8d2c4;border-radius:8px;font-size:15px;font-family:inherit;background:#fff}
#form textarea{min-height:96px;resize:vertical}
.attrrow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
#preview{background:#efe9dd;display:flex;flex-direction:column;align-items:center;padding:24px;overflow-y:auto}
#diffbox{margin-top:18px;width:100%;background:#fff;border-radius:10px;padding:12px 16px;font-size:13px;box-shadow:0 1px 5px rgba(0,0,0,.08)}
#diffbox h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;color:var(--mut)}
#diffbox .old{background:#fde8e8;text-decoration:line-through;padding:0 4px;border-radius:3px}
#diffbox .new{background:#e5f5e0;padding:0 4px;border-radius:3px}
/* ---- the card: HTML/CSS template (same layout language as the renderer) ---- */
.card{width:275px;height:385px;border-radius:14px;position:relative;box-shadow:0 6px 22px rgba(0,0,0,.25);flex:none;background:var(--cbg,#f6e3d3);border:4px solid var(--cfg,#8c2f1b);padding:14px;font-size:12px}
.card .name{background:var(--cfg);color:#fff;border-radius:8px;padding:8px 10px 8px 40px;font-weight:800;font-size:15px;position:relative;min-height:20px}
.card .cost{position:absolute;left:-6px;top:-6px;width:34px;height:34px;border-radius:50%;background:#fff;border:3px solid var(--cfg);color:var(--cfg);font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center}
.card .tline{color:var(--cfg);margin:7px 0 6px;font-size:11.5px}
.card .art{height:100px;border:1.5px solid var(--cfg);background:repeating-linear-gradient(45deg,transparent,transparent 9px,color-mix(in srgb,var(--cfg) 30%,transparent) 10px)}
.card .txt{margin-top:8px;line-height:1.45;white-space:pre-wrap}
.card .kw{color:var(--cfg);font-size:10px;letter-spacing:.6px;margin-top:6px;font-weight:700}
.card .power{position:absolute;right:10px;bottom:10px;width:40px;height:40px;border-radius:50%;background:var(--cfg);color:#fff;font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center}
.card .foot{position:absolute;left:14px;bottom:14px;color:#888;font-size:9.5px}
</style></head><body>
<header><h1 id="gtitle"></h1>
<button class="btn ghost" onclick="document.getElementById('csvfile').click()">⇪ Import YOUR spreadsheet</button>
<input type="file" id="csvfile" accept=".csv,.tsv,text/csv" style="display:none" onchange="importCSVFile(this.files[0])">
<button class="btn ghost" onclick="addCard()">+ New card</button>
<button class="btn" onclick="download()">⤓ Download cards.json</button></header>
<div id="wrap"><div id="list"></div><div id="form"></div>
<div id="preview"><div class="card" id="cardEl"></div><div id="diffbox"></div></div></div>
<script>
const DATA = __DATA__;
const ORIGINAL = JSON.parse(JSON.stringify(DATA.cards));
let cards = DATA.cards, cur = 0;
const PALETTE = [["#8c2f1b","#f6e3d3"],["#1b4f8c","#dbe9f6"],["#3a6b28","#e2f0d9"],["#6b285a","#f0d9ea"],["#7a5a1b","#f4ead2"],["#37474f","#e0e7ea"]];
const GLYPHS = Object.assign({spark:"✦",ash:"▲",cargo:"■",credit:"¤",mu:"μ",click:"◇",link:"⚑"}, DATA.glyphs||{});
const esc = s => (s??"").toString().replace(/&/g,"&amp;").replace(/</g,"&lt;");
document.getElementById("gtitle").textContent = DATA.title + " — card editor";

function colors(type){
  const tc=(DATA.type_colors||{})[type]; if(tc) return [tc.fg,tc.bg];
  const types=[...new Set(cards.map(c=>c.type))].sort(); return PALETTE[Math.max(0,types.indexOf(type))%PALETTE.length]; }
function sym(t){ return (t??"").replace(/\[([a-z0-9_]+)\]/g,(m,k)=>GLYPHS[k]??k.toUpperCase()); }

function renderList(){
  const el=document.getElementById("list"); el.innerHTML="";
  cards.forEach((c,i)=>{ const b=document.createElement("button");
    b.textContent=c.name||"(unnamed)"; b.className=(i===cur?"on":"")+(isDirty(c)?" dirty":"");
    b.onclick=()=>{cur=i;renderAll()}; el.appendChild(b); });
}
function isDirty(c){ const o=ORIGINAL.find(x=>x.id===c.id); return !o||JSON.stringify(o)!==JSON.stringify(c); }

function field(label,val,cb,tag="input"){
  const l=document.createElement("label"); l.textContent=label;
  const i=document.createElement(tag); i.value=val??"";
  i.oninput=()=>{cb(i.value);renderCard();renderDiff();renderList()};
  return [l,i];
}
function renderForm(){
  const c=cards[cur], f=document.getElementById("form"); f.innerHTML="";
  const add=(els)=>els.forEach(e=>f.appendChild(e));
  add(field("Name",c.name,v=>c.name=v));
  add(field("Type",c.type,v=>c.type=v));
  add(field("Subtypes (comma-separated)",(c.subtypes||[]).join(", "),v=>c.subtypes=v.split(",").map(s=>s.trim()).filter(Boolean)));
  add(field("Rules text — symbols like [spark] allowed",c.text,v=>c.text=v,"textarea"));
  add(field("Keywords (comma-separated)",(c.keywords||[]).join(", "),v=>c.keywords=v.split(",").map(s=>s.trim()).filter(Boolean)));
  const row=document.createElement("div"); row.className="attrrow";
  for(const d of DATA.attribute_definitions){
    const wrap=document.createElement("div");
    const [l,i]=field(d.name||d.key,(c.attributes||{})[d.key],v=>{
      c.attributes=c.attributes||{};
      if(v==="")delete c.attributes[d.key];
      else c.attributes[d.key]=(d.type==="integer"||d.type==="number")?Number(v):v;});
    if(d.type==="integer"||d.type==="number")i.type="number";
    wrap.appendChild(l);wrap.appendChild(i);row.appendChild(wrap);
  }
  const wrap=document.createElement("div");
  const [l,i]=field("Deck limit",c.deck_limit,v=>c.deck_limit=v===""?undefined:Number(v)); i.type="number";
  wrap.appendChild(l);wrap.appendChild(i);row.appendChild(wrap);
  f.appendChild(row);
}
function renderCard(){
  const c=cards[cur],[fg,bg]=colors(c.type),el=document.getElementById("cardEl");
  el.style.setProperty("--cfg",fg); el.style.setProperty("--cbg",bg);
  const cost=(c.attributes||{}).cost, power=(c.attributes||{}).power;
  el.innerHTML=`
   <div class="name">${cost!=null?`<div class="cost">${esc(cost)}</div>`:""}${esc(c.name)}</div>
   <div class="tline">${esc((c.type||"").charAt(0).toUpperCase()+(c.type||"").slice(1))}${c.subtypes&&c.subtypes.length?" • "+esc(c.subtypes.join(", ")):""}</div>
   <div class="art"></div>
   <div class="txt">${esc(sym(c.text))}</div>
   ${c.keywords&&c.keywords.length?`<div class="kw">${esc(c.keywords.join(" ✦ ").toUpperCase())}</div>`:""}
   ${power!=null?`<div class="power">${esc(power)}</div>`:""}
   <div class="foot">${esc(DATA.title)}</div>`;
}
function flat(c){ const d={name:c.name,type:c.type,subtypes:(c.subtypes||[]).join(", "),text:c.text||"",keywords:(c.keywords||[]).join(", "),deck_limit:c.deck_limit};
  for(const[k,v]of Object.entries(c.attributes||{}))d["attributes."+k]=v; return d; }
function renderDiff(){
  const box=document.getElementById("diffbox"); let out="";
  for(const c of cards){ const o=ORIGINAL.find(x=>x.id===c.id);
    if(!o){out+=`<div><strong>${esc(c.name)}</strong> <span class="new">+ added</span></div>`;continue;}
    const a=flat(o),b=flat(c);
    for(const k of new Set([...Object.keys(a),...Object.keys(b)]))
      if(JSON.stringify(a[k])!==JSON.stringify(b[k]))
        out+=`<div><strong>${esc(c.name)}</strong> · ${esc(k)}: <span class="old">${esc(a[k])}</span> → <span class="new">${esc(b[k])}</span></div>`;
  }
  box.innerHTML="<h4>Changes vs loaded version"+(out?"":" — none yet")+"</h4>"+(out||"<span style='color:#999'>Edit a field and watch this become your commit message.</span>");
}
/* ---- in-browser CSV import: the happy path, no CLI required ---- */
const CORE_COLS = new Set(["id","name","type","subtypes","keywords","text","deck_limit","set","collector_number","quantity","artist","flavor_text"]);
function parseCSV(text){
  const rows=[]; let row=[],field="",inQ=false;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false; } else field+=ch; }
    else if(ch==='"') inQ=true;
    else if(ch===','||ch==='\t'){ row.push(field); field=""; }
    else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n')i++;
      row.push(field); field=""; if(row.some(c=>c!=="")) rows.push(row); row=[]; }
    else field+=ch; }
  if(field!==""||row.length){ row.push(field); if(row.some(c=>c!=="")) rows.push(row); }
  return rows;
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"card";
function importCSVFile(file){
  if(!file) return;
  const r=new FileReader();
  r.onload=()=>importCSVText(r.result, file.name.replace(/\.[^.]+$/,""));
  r.readAsText(file);
}
function importCSVText(text, name){
  const rows=parseCSV(text);
  if(rows.length<2){ alert("Need a header row plus at least one card row."); return; }
  const headers=rows[0].map(h=>h.trim().toLowerCase());
  if(!headers.includes("name")){ alert("No 'name' column found — the importer needs at least a name column. Got: "+headers.join(", ")); return; }
  const recs=rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]??"").trim()])));
  const attrCols=headers.filter(h=>!CORE_COLS.has(h));
  const infer=col=>{ const v=recs.map(r=>r[col]??"").filter(x=>x!=="");
    if(v.length&&v.every(x=>/^-?\d+$/.test(x))) return "integer";
    if(v.length&&v.every(x=>/^-?\d+(\.\d+)?$/.test(x))) return "number";
    if(v.length&&v.every(x=>/^(true|false)$/i.test(x))) return "boolean";
    return "string"; };
  const types=Object.fromEntries(attrCols.map(c=>[c,infer(c)]));
  const cast=(v,t)=>t==="integer"?parseInt(v,10):t==="number"?parseFloat(v):t==="boolean"?/^true$/i.test(v):v;
  const seen=new Set(); const imported=[];
  for(const r of recs){
    if(!r.name) continue;
    let id=slug(r.id||r.name); let n=2;
    while(seen.has(id)) id=slug(r.id||r.name)+"_"+n++;
    seen.add(id);
    const c={id,name:r.name,type:r.type||"card"};
    if(r.subtypes) c.subtypes=r.subtypes.split(";").map(s=>s.trim()).filter(Boolean);
    if(r.text) c.text=r.text;
    if(r.keywords) c.keywords=r.keywords.split(";").map(s=>s.trim()).filter(Boolean);
    const attrs={};
    for(const col of attrCols) if(r[col]!==""&&r[col]!=null) attrs[col]=cast(r[col],types[col]);
    if(Object.keys(attrs).length) c.attributes=attrs;
    if(r.deck_limit) c.deck_limit=parseInt(r.deck_limit,10);
    imported.push(c);
  }
  if(!imported.length){ alert("No card rows found."); return; }
  DATA.title=(name||"Your game").replace(/[-_]/g," ");
  DATA.attribute_definitions=attrCols.map(k=>({key:k,name:k[0].toUpperCase()+k.slice(1),type:types[k]}));
  DATA.type_colors={};
  cards=imported; DATA.cards=cards;
  ORIGINAL.length=0; for(const c of imported) ORIGINAL.push(JSON.parse(JSON.stringify(c)));
  cur=0;
  document.getElementById("gtitle").textContent=DATA.title+" — card editor";
  renderAll();
}
document.addEventListener("dragover",e=>e.preventDefault());
document.addEventListener("drop",e=>{ e.preventDefault();
  const f=e.dataTransfer?.files?.[0];
  if(f&&/\.(csv|tsv)$/i.test(f.name)) importCSVFile(f); });

function addCard(){
  const id="card_"+Math.random().toString(36).slice(2,8);
  cards.push({id,name:"New Card",type:cards[0]?.type||"card",text:"",attributes:{}});
  cur=cards.length-1; renderAll();
}
function download(){
  const blob=new Blob([JSON.stringify(cards,null,2)+"\n"],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="cards.json"; a.click();
}
function renderAll(){renderList();renderForm();renderCard();renderDiff();}
renderAll();
</script></body></html>"""
    page = page.replace("__TITLE__", html.escape(payload["title"])).replace("__DATA__", data_js)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page)
    print(f"Editor: {out_path}  ({out_path.stat().st_size//1024} KB, self-contained)")

if __name__ == "__main__":
    main()
