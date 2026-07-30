#!/usr/bin/env python3
"""stats.py - design & playtest analytics ("fmt stats"), format v0.1.
Usage: python3 tools/stats.py <game-dir> [--json]

Two lenses a designer needs on every visit:
  DESIGN  - cost curve, type distribution, power-per-cost, keyword frequency
            (works with zero playtests; instant value on any imported game)
  TABLE   - playtest aggregation: sessions, game results, most-flagged cards
            ranked by tag, and the decision trail (session -> action)
"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path
import yaml

game_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if not game_dir: sys.exit("Usage: python3 tools/stats.py <game-dir> [--json]")
as_json = "--json" in sys.argv

game = yaml.safe_load((game_dir / "game.yaml").read_text())
cards = json.loads((game_dir / "components/cards.json").read_text())
playtests = []
pt = game_dir / "playtests"
if pt.is_dir():
    for f in sorted(pt.glob("*.json")):
        playtests.append(json.loads(f.read_text()))

# ---- design stats ----
costs = [c.get("attributes", {}).get("cost") for c in cards if c.get("attributes", {}).get("cost") is not None]
curve = Counter(costs)
types = Counter(c["type"] for c in cards)
keywords = Counter(k for c in cards for k in c.get("keywords", []))
by_cost_power = defaultdict(list)
for c in cards:
    a = c.get("attributes", {})
    if a.get("cost") is not None and a.get("power") is not None:
        by_cost_power[a["cost"]].append(a["power"])
ppc = {k: round(sum(v) / len(v), 2) for k, v in sorted(by_cost_power.items())}

# ---- playtest aggregation ----
results = Counter()
flagged = defaultdict(lambda: Counter())
notes_by_card = defaultdict(list)
decisions = []
minutes = 0
for s in playtests:
    minutes += s.get("duration_minutes", 0)
    for p in s.get("players", []):
        if p.get("result"): results[p["result"]] += 1
    for n in s.get("card_notes", []):
        flagged[n["card_id"]][n["tag"]] += 1
        notes_by_card[n["card_id"]].append(n)
    for d in s.get("decisions", []):
        decisions.append({"session": s["id"], "date": s["date"], **d})
card_names = {c["id"]: c["name"] for c in cards}
flag_rank = sorted(flagged.items(), key=lambda kv: -sum(kv[1].values()))

if as_json:
    print(json.dumps({
        "curve": dict(sorted(curve.items())), "types": dict(types), "keywords": dict(keywords),
        "power_per_cost": ppc, "sessions": len(playtests), "table_minutes": minutes,
        "results": dict(results),
        "flagged": {cid: dict(tags) for cid, tags in flag_rank},
        "flagged_names": {cid: card_names.get(cid, cid) for cid, _ in flag_rank},
        "decisions": decisions,
    }, indent=2))
    sys.exit(0)

W = 26
bar = lambda n, mx: "█" * max(1, round(n / mx * W)) if mx else ""
print(f"{game.get('title','?')} — design & playtest stats\n")
print("COST CURVE")
mx = max(curve.values(), default=0)
for cost in sorted(curve):
    print(f"  {cost:>2}  {bar(curve[cost], mx):<{W}} {curve[cost]}")
print("\nTYPES        " + " · ".join(f"{t}: {n}" for t, n in types.most_common()))
if keywords: print("KEYWORDS     " + " · ".join(f"{k}: {n}" for k, n in keywords.most_common()))
if ppc: print("POWER/COST   " + " · ".join(f"cost {c}: avg {p}" for c, p in ppc.items()))

if playtests:
    print(f"\nPLAYTESTS    {len(playtests)} session(s), {minutes} minutes at the table")
    print(f"RESULTS      " + " · ".join(f"{k}: {n}" for k, n in results.items()))
    if flag_rank:
        print("\nMOST-FLAGGED CARDS")
        for cid, tags in flag_rank[:6]:
            print(f"  {card_names.get(cid, cid):<16} {sum(tags.values())}× ({', '.join(f'{t}:{n}' for t, n in tags.most_common())})")
    if decisions:
        print("\nDECISION TRAIL (session → action)")
        for d in decisions:
            tgt = f" [{card_names.get(d.get('card_id'), d.get('card_id'))}]" if d.get("card_id") else ""
            print(f"  {d['date']}  {d['action']}{tgt}")
else:
    print("\nPLAYTESTS    none logged yet — playtests/*.json (see playtest.schema.json)")
