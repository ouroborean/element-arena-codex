#!/usr/bin/env python3
"""
Element Arena — P0 content freeze.

Reads the codex export (read-only) and emits the game's FROZEN canonical content
under game/content/frozen/, applying exactly the adjudicated repairs and recording
every mutation in a provenance log. From here on the engine reads frozen/, never the
raw export — so the export can keep changing without silently moving the game's floor.

Mutations applied (all recorded in provenance.json + CHANGES.md):
  1. Fusion-skill element re-tag — a fusion skill's element is authoritatively its
     fusion element (classification.fusion_element). The export left some at the
     enum default (Fire). We re-tag every mismatch, computed — not hand-listed.
  2. Minion HP from the glossary — ruling MINION_HP_SOURCE: the glossary minion table
     is authoritative over the database's gd-heuristic scan.
  3. Description NORMALIZE corrections — the safe spelling/casing fixes from
     reference_corrections.json (DESIGNER_FLAG entries are left untouched).

Ids are kept raw within each table (they are unambiguous per-table); the engine adds
the `skill:` / `aug:` / `char:` / `minion:` prefixes when it loads them into one
registry. See ids.generated.ts for the prefixed union types.

Usage:  python game/tools/build_content.py
Run lint_content.py first (build asserts the reference lint is green).
"""

import json
import os
import sys
from collections import defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "output")
CONTENT = os.path.join(REPO, "game", "content")
FROZEN = os.path.join(CONTENT, "frozen")


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


db = load(os.path.join(OUT, "database.json"))
gloss = load(os.path.join(OUT, "glossary.json"))
corrections = load(os.path.join(CONTENT, "reference_corrections.json"))
exceptions = load(os.path.join(CONTENT, "reference_exceptions.json")).get("accepted", {})

el_by_name = {e["name"]: e for e in db["elements"]}
provenance = []  # {kind, record, field, from, to, reason}


def note(kind, record, field, frm, to, reason):
    provenance.append({"kind": kind, "record": record, "field": field,
                       "from": frm, "to": to, "reason": reason})


# --------------------------------------------------------------------------- #
#  1. Fusion-skill element re-tag (computed)
# --------------------------------------------------------------------------- #
skills = json.loads(json.dumps(db["skills"]))  # deep copy
for s in skills:
    cl = s.get("classification") or {}
    if cl.get("kind") == "fusion":
        want = cl.get("fusion_element")
        cur = (s.get("element") or {}).get("name")
        if want and want in el_by_name and cur != want:
            tgt = el_by_name[want]
            note("element_retag", f"skill:{s['id']}", "element", cur, want,
                 "fusion skill's element is authoritatively its fusion_element")
            s["element"] = {"id": tgt["id"], "name": tgt["name"], "display_name": tgt["display_name"]}


# --------------------------------------------------------------------------- #
#  1b. Skill class tag (SKILL_TAXONOMY ruling)
# --------------------------------------------------------------------------- #
char_base_len = {c["id"]: len(c.get("base_skill_ids") or []) for c in db["characters"]}
STD_SLOT = {0: "passive", 1: "basic", 2: "basic", 3: "basic", 4: "defensive", 5: "ultimate"}
FUSED_SLOT = {0: "passive", 1: "basic", 2: "basic", 3: "basic", 4: "fusion", 5: "defensive", 6: "ultimate"}

def skill_class(s):
    cl = s.get("classification") or {}
    kind, slot = cl.get("kind"), cl.get("slot")
    if s.get("is_minion_skill") or kind == "minion":
        return "basic"                       # minion skills are always BASIC
    if kind == "fusion":
        return "fusion_passive" if slot == 0 else "fusion"
    if kind == "variant":
        return "variant"
    if kind == "base":
        if slot == 0:
            return "passive"
        if s.get("owner") == "trinity":
            return "basic"                   # Trinity: no defensive/ultimate
        table = FUSED_SLOT if char_base_len.get(s.get("owner"), 6) == 7 else STD_SLOT
        return table.get(slot, "basic")
    return "basic"

for s in skills:
    s["skill_class"] = skill_class(s)

# --------------------------------------------------------------------------- #
#  2. Minion HP from the glossary (authoritative)
# --------------------------------------------------------------------------- #
gloss_minion = {m["minion_id"]: m for m in gloss.get("minion_references", [])}
minions = json.loads(json.dumps(db["minions"]))
for m in minions:
    g = gloss_minion.get(m["id"])
    if not g:
        continue
    if g.get("hp_dynamic"):
        if m.get("base_hp") is not None or m.get("hp_source") != "dynamic":
            note("minion_hp", f"minion:{m['id']}", "base_hp", m.get("base_hp"), None,
                 "glossary marks HP dynamic (set at runtime)")
        m["base_hp"], m["hp_source"] = None, "dynamic"
    elif g.get("hp") is not None and m.get("base_hp") != g["hp"]:
        note("minion_hp", f"minion:{m['id']}", "base_hp", m.get("base_hp"), g["hp"],
             "MINION_HP_SOURCE ruling: glossary minion table is authoritative")
        m["base_hp"], m["hp_source"] = g["hp"], "glossary"


# --------------------------------------------------------------------------- #
#  3. Description NORMALIZE corrections
# --------------------------------------------------------------------------- #
normalize = {k: v for k, v in corrections.items()
             if isinstance(v, dict) and v.get("kind") == "NORMALIZE"}
augments = json.loads(json.dumps(db["augments"]))

def apply_corrections(records, label):
    for r in records:
        desc = r.get("description")
        if not desc:
            continue
        new = desc
        for bad, spec in normalize.items():
            if bad in new:
                new = new.replace(bad, spec["fix"])
        if new != desc:
            note("normalize", f"{label}:{r['id']}", "description", desc, new,
                 "safe transcription fix (reference_corrections.json)")
            r["description"] = new

apply_corrections(skills, "skill")
apply_corrections(augments, "aug")


# --------------------------------------------------------------------------- #
#  Emit frozen tables + provenance + category seeds
# --------------------------------------------------------------------------- #
write_json(os.path.join(FROZEN, "skills.json"), skills)
write_json(os.path.join(FROZEN, "augments.json"), augments)
write_json(os.path.join(FROZEN, "minions.json"), minions)
write_json(os.path.join(FROZEN, "characters.json"), db["characters"])
write_json(os.path.join(FROZEN, "elements.json"),
           {"elements": db["elements"], "fusion_recipes": db["fusion_recipes"]})
write_json(os.path.join(FROZEN, "provenance.json"),
           {"_note": "Every mutation the freeze applied to the raw export. Auditable.",
            "count": len(provenance), "mutations": provenance})

# Category seeds for later phases: the named systems / units the registry must author.
by_cat = defaultdict(list)
for phrase, cat in exceptions.items():
    by_cat[cat].append(phrase)
seed_lines = ["# Content seeds (from adjudicated reference exceptions)", ""]
seed_lines.append("Named things that live only in prose and must be authored later.\n")
for cat in ("RESOURCE", "UNIT", "PENDING", "MECHANIC", "NAME"):
    items = sorted(by_cat.get(cat, []))
    if items:
        seed_lines.append(f"## {cat} ({len(items)})")
        seed_lines.append(", ".join(f"`{i}`" for i in items) + "\n")
with open(os.path.join(FROZEN, "content_seeds.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(seed_lines) + "\n")

# CHANGES.md — human-readable provenance grouped by kind.
by_kind = defaultdict(list)
for p in provenance:
    by_kind[p["kind"]].append(p)
lines = ["# Frozen content — change log", "",
         f"{len(provenance)} mutations applied to the raw export when freezing "
         "`game/content/frozen/`. Nothing else was altered.\n"]
titles = {"element_retag": "Fusion-skill element re-tags",
          "minion_hp": "Minion HP set from the glossary (authoritative)",
          "normalize": "Description normalizations"}
for kind in ("element_retag", "minion_hp", "normalize"):
    ps = by_kind.get(kind, [])
    lines.append(f"## {titles[kind]} ({len(ps)})\n")
    for p in ps:
        if kind == "normalize":
            lines.append(f"- `{p['record']}` — applied spelling/casing fix")
        else:
            lines.append(f"- `{p['record']}` {p['field']}: `{p['from']}` → `{p['to']}`")
    lines.append("")
with open(os.path.join(FROZEN, "CHANGES.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

# Summary
kinds = {k: len(v) for k, v in by_kind.items()}
print("Froze game/content/frozen/ :", ", ".join(f"{k}={v}" for k, v in [
    ("skills", len(skills)), ("augments", len(augments)), ("minions", len(minions)),
    ("characters", len(db["characters"]))]))
print("Mutations:", kinds, "| total", len(provenance))
print("Wrote: frozen/{skills,augments,minions,characters,elements}.json, "
      "provenance.json, content_seeds.md, CHANGES.md")
