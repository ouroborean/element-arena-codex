"""Split effect_context.json into trimmed per-agent batch files for the authoring workflow.

Each batch file is a small, self-contained JSON list of effects with just enough grounding
(applier description + how other skills reference the effect) to author its state-description.
Run from repo root AFTER gen_effect_context.py: python game/web/tools/gen_effect_batches.py
"""
import json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ctx = json.load(open(os.path.join(ROOT, "game/web/tools/effect_context.json"), encoding="utf-8"))
BATCH_DIR = os.path.join(ROOT, "game/web/tools/batches")
os.makedirs(BATCH_DIR, exist_ok=True)
for old in os.listdir(BATCH_DIR):
    os.remove(os.path.join(BATCH_DIR, old))

def trim(name, c):
    ms = []
    seen = set()
    for m in c["mentions"]:
        who = m.get("skill") or m.get("augment") or "?"
        d = (m["desc"] or "").strip()
        key = d[:80]
        if key in seen:
            continue
        seen.add(key)
        ms.append(f"[{who}] {d[:180]}")
        if len(ms) >= 8:
            break
    return {
        "name": name,
        "kind": c["kind"],
        "appliedBy": c.get("applierName"),
        "applierSays": (c["applierDesc"] or "")[:200],
        "referencedBy": ms,  # how OTHER skills read/use this effect — where its meaning lives
        "maybePlumbing": c["maybePlumbing"],
    }

items = [trim(n, c) for n, c in sorted(ctx.items())]
N = 14
batches = [items[i::N] for i in range(N)]  # round-robin so each batch mixes heroes (even sizing)
for i, b in enumerate(batches):
    json.dump(b, open(os.path.join(BATCH_DIR, f"batch_{i:02d}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"wrote {N} batches to {BATCH_DIR} ({len(items)} effects, ~{len(batches[0])} each)")
