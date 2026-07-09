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
        "attribute_definitions": game.get("attribute_definitions") or [],
        "symbols": {s["key"]: s.get("name", s["key"]) for s in (game.get("symbols") or [])},
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
<button class="btn ghost" onclick="addCard()">+ New card</button>
<button class="btn" onclick="download()">⤓ Download cards.json</button></header>
<div id="wrap"><div id="list"></div><div id="form"></div>
<div id="preview"><div class="card" id="cardEl"></div><div id="diffbox"></div></div></div>
<script>
const DATA = __DATA__;
const ORIGINAL = JSON.parse(JSON.stringify(DATA.cards));
let cards = DATA.cards, cur = 0;
const PALETTE = [["#8c2f1b","#f6e3d3"],["#1b4f8c","#dbe9f6"],["#3a6b28","#e2f0d9"],["#6b285a","#f0d9ea"],["#7a5a1b","#f4ead2"],["#37474f","#e0e7ea"]];
const GLYPHS = {spark:"✦",ash:"▲",cargo:"■",credit:"¤",mu:"μ",click:"◇",link:"⚑"};
const esc = s => (s??"").toString().replace(/&/g,"&amp;").replace(/</g,"&lt;");
document.getElementById("gtitle").textContent = DATA.title + " — card editor";

function colors(type){ const types=[...new Set(cards.map(c=>c.type))].sort(); return PALETTE[Math.max(0,types.indexOf(type))%PALETTE.length]; }
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
