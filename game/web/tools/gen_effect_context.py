"""Build grounding context for authoring per-effect (mark/stack) descriptions.

For each distinct named mark/stack applied in the engine content, gather:
  - kind, the skill/passive that applies it (from statussource), and that skill's own description
  - EVERY frozen description (skills + augments) that references the effect NAME — this is where the
    effect's actual meaning lives (a mark means whatever the skills that read it make it mean)

Writes effect_context.json (input to the authoring workflow) + a coverage report to stdout.
Run from repo root: python game/web/tools/gen_effect_context.py
"""
import json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
def load(p): return json.load(open(os.path.join(ROOT, p), encoding="utf-8"))

skills = load("game/content/frozen/skills.json")
augments = load("game/content/frozen/augments.json")
SKILL = {s["id"]: s for s in skills}

# Fusion skill ids — references from a fusion form are NOT part of the effect's base/current behavior.
_fus = open(os.path.join(ROOT, "game/engine/content/fusions.generated.ts"), encoding="utf-8").read()
FUSION_IDS = set(re.findall(r'"id":\s*"([a-z0-9]+)"', _fus))

# statussource.generated.ts: status name -> applying skill/passive id
sstxt = open(os.path.join(ROOT, "game/web/src/statussource.generated.ts"), encoding="utf-8").read()
STATUS_SOURCE = json.loads(re.search(r"=\s*(\{.*\});", sstxt, re.S).group(1))

# Distinct named marks/stacks applied anywhere in authored content.
kinds = {}  # name -> kind
for f in ["roster.generated.ts", "fusions.generated.ts", "augments.generated.ts"]:
    txt = open(os.path.join(ROOT, "game/engine/content", f), encoding="utf-8").read()
    for m in re.finditer(r'"kind":\s*"(mark|stack)"[^}]*?"name":\s*"([^"]+)"', txt):
        kinds.setdefault(m.group(2), m.group(1))
    for m in re.finditer(r'"op":\s*"addStack"[^}]*?"name":\s*"([^"]+)"', txt):
        kinds.setdefault(m.group(1), "stack")

# All description sources: frozen skills + augments (fusion skills are already in skills.json).
def aug_text(a):
    return " ".join(str(a.get(k, "")) for k in ("name", "description", "effect"))
DESCS = [(s.get("name", ""), s.get("id", ""), s.get("description", "") or "") for s in skills]
AUG_DESCS = [(a.get("name", ""), a.get("id", ""), aug_text(a)) for a in augments]

# Internal-plumbing marks (bookkeeping the engine leaks as a status) — candidates to HIDE, not describe.
PLUMBING = re.compile(r"(Acted|Spent|Handled|no-trigger|noOverclock|Proc Lock|: |Uses|Armed|Given|Suppressed|Override|CD$)")

ctx = {}
for name, kind in sorted(kinds.items()):
    applied_by = STATUS_SOURCE.get(name)
    applier_desc = (SKILL.get(applied_by, {}) or {}).get("description", "") if applied_by else ""
    mentions = []
    for nm, sid, d in DESCS:
        if name in d and sid not in FUSION_IDS:  # base-kit references only; a fusion form is not current behavior
            mentions.append({"skill": nm, "id": sid, "desc": d})
    for nm, aid, d in AUG_DESCS:
        if name in d:
            mentions.append({"augment": nm, "id": aid, "desc": d})
    cond = re.search(r"[Ww]hile ([A-Z][a-zA-Z][a-zA-Z -]*?)[,.]", applier_desc)
    ctx[name] = {
        "kind": kind,
        "appliedBy": applied_by,
        "applierName": (SKILL.get(applied_by, {}) or {}).get("name") if applied_by else None,
        "applierDesc": applier_desc,
        "conditionalOn": cond.group(1).strip() if cond else None,  # a "While X" clause → a state-gated variant
        "mentions": mentions,
        "maybePlumbing": bool(PLUMBING.search(name)),
    }

out = os.path.join(ROOT, "game/web/tools/effect_context.json")
json.dump(ctx, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# Coverage report
total = len(ctx)
no_ctx = [n for n, c in ctx.items() if not c["mentions"] and not c["applierDesc"]]
plumb = [n for n, c in ctx.items() if c["maybePlumbing"]]
print(f"wrote {out}: {total} effects ({sum(1 for c in ctx.values() if c['kind']=='mark')} marks, {sum(1 for c in ctx.values() if c['kind']=='stack')} stacks)")
print(f"  with NO grounding (no mentions + no applier desc): {len(no_ctx)} -> {no_ctx[:20]}")
print(f"  flagged maybe-plumbing: {len(plumb)} -> {plumb[:20]}")
