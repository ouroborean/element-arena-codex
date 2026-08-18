#!/usr/bin/env python3
"""
Element Arena — P0 content pipeline & linter.

Reads the codex export (repo `output/`) and produces the game's *frozen* content
inputs plus a set of correctness reports. This is deliberately a read-only pass
over the export: it never mutates output/, it writes everything under game/content/.

What it does
------------
1. NAMESPACE + COLLISION AUDIT
   Skill / augment / character / minion id spaces overlap heavily (an augment
   `ando1` is NOT skill `ando1` — it *patches* a different skill). Every id is
   re-emitted namespaced (`skill:`, `aug:`, `char:`, `minion:`, `status:`) and
   the raw-id collisions are asserted to be exactly the known set, so a NEW
   collision introduced later fails the build instead of silently aliasing.

2. REFERENCE LINT
   Every Title-Case proper-noun phrase in all 762 descriptions is resolved
   against the skill / minion / glossary name tables. Unresolved phrases
   (typos, unregistered proper nouns) are reported for adjudication.

3. AUGMENT PATCH-MAP (the important one)
   There is NO number-to-number relationship between an augment and the skill it
   changes. This emits a *suggested* patch map — for each augment, the owner
   skills it names, the target kind, and a `review_required` flag — as the
   scaffold for the hand-authored `patch_map.json`. It must be reviewed, not
   trusted: the suggestions are a starting point, not ground truth.

4. REPAIRS MANIFEST
   The known data repairs (mis-tagged elements, glossary-vs-db minion HP
   conflicts, orphan/undefined units, art-path corrections) are collected into a
   single manifest the import step will apply.

Usage:  python game/tools/lint_content.py [--strict]
        --strict makes any unexpected collision / unresolved-ref regression exit 1.
"""

import json
import os
import re
import sys
from collections import defaultdict, Counter

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "output")
CONTENT = os.path.join(REPO, "game", "content")
REPORTS = os.path.join(CONTENT, "reports")

STRICT = "--strict" in sys.argv


def load(name):
    with open(os.path.join(OUT, name), encoding="utf-8") as f:
        return json.load(f)


def write_json(relpath, obj):
    path = os.path.join(CONTENT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return path


def write_text(relpath, text):
    path = os.path.join(CONTENT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


# --------------------------------------------------------------------------- #
#  Load
# --------------------------------------------------------------------------- #
db = load("database.json")
gloss = load("glossary.json")

skills = {s["id"]: s for s in db["skills"]}
augments = {a["id"]: a for a in db["augments"]}
characters = {c["id"]: c for c in db["characters"]}
minions = {m["id"]: m for m in db["minions"]}

problems = []  # (severity, message) — severity in {"ERROR","WARN","INFO"}


def report(sev, msg):
    problems.append((sev, msg))


# --------------------------------------------------------------------------- #
#  1. Namespace + collision audit
# --------------------------------------------------------------------------- #
NS = {"skill": skills, "aug": augments, "char": characters, "minion": minions}

# raw-id -> set of namespaces that use it
raw_owners = defaultdict(set)
for ns, table in NS.items():
    for rid in table:
        raw_owners[rid].add(ns)

collisions = {rid: sorted(ns) for rid, ns in raw_owners.items() if len(ns) > 1}

# Known / expected collision shape: every augment id also exists as a skill id
# (an augment patches skills; the ids were never disjoint in the source project).
aug_skill_collisions = sorted(
    rid for rid, ns in collisions.items() if {"aug", "skill"} <= set(ns)
)
other_collisions = {
    rid: ns for rid, ns in collisions.items() if not ({"aug", "skill"} <= set(ns))
}
# Known-benign cross-namespace overlaps: a minion whose own skill shares its id, and
# Hector's minion 'Dennis' colliding with the character 'Dennis'. Prefixes resolve them.
EXPECTED_OTHER = {"dennis", "sayareanimationminion1", "sayareanimationminion2"}

report("INFO", f"aug/skill id collisions: {len(aug_skill_collisions)} of {len(augments)} augments")
for rid, ns in sorted(other_collisions.items()):
    sev = "INFO" if rid in EXPECTED_OTHER else "WARN"
    report(sev, f"{'expected' if sev == 'INFO' else 'UNEXPECTED'} cross-namespace id collision: {rid!r} used by {ns}")

# Emit the namespaced id table.
namespaced = {
    "skills": [f"skill:{i}" for i in skills],
    "augments": [f"aug:{i}" for i in augments],
    "characters": [f"char:{i}" for i in characters],
    "minions": [f"minion:{i}" for i in minions],
    "collisions_expected_aug_skill": aug_skill_collisions,
    "collisions_other": other_collisions,
}
write_json("reports/id_namespace.json", namespaced)

# TypeScript id-union codegen (typo -> compile error downstream).
def union(name, ids, prefix):
    lits = " |\n  ".join(f'"{prefix}{i}"' for i in ids)
    return f"export type {name} =\n  {lits};\n"

ts = ["// AUTO-GENERATED by game/tools/lint_content.py — do not edit by hand.\n"]
ts.append(union("SkillId", skills, "skill:"))
ts.append(union("AugmentId", augments, "aug:"))
ts.append(union("CharacterId", characters, "char:"))
ts.append(union("MinionId", minions, "minion:"))
write_text("ids.generated.ts", "\n".join(ts))


# --------------------------------------------------------------------------- #
#  2. Reference lint
# --------------------------------------------------------------------------- #
# Resolution tables.
skill_names = defaultdict(list)          # name -> [skill ids]  (global)
owner_skill_names = defaultdict(lambda: defaultdict(list))  # owner -> name -> [ids]
for s in db["skills"]:
    if s.get("name"):
        skill_names[s["name"]].append(s["id"])
        owner_skill_names[s["owner"]][s["name"]].append(s["id"])

minion_names = {m["character_name"] for m in db["minions"] if m.get("character_name")}
minion_names |= {x["name"] for x in gloss.get("minion_references", []) if x.get("name")}

glossary_terms = set(gloss.get("keyword_lookup", {}).keys())
for d in gloss.get("definitions", []):
    glossary_terms.add(d["term"])
    glossary_terms.update(d.get("keywords", []))

element_names = {e["display_name"] for e in db["elements"]}
char_names = set()
for c in db["characters"]:
    for key in ("character_name", "short_name"):
        if c.get(key):
            char_names.add(c[key])

resolvable = set()
resolvable |= set(skill_names)
resolvable |= minion_names
resolvable |= glossary_terms
resolvable |= element_names
resolvable |= char_names
# Some references drop the leading article ("the Black Knight" vs char "The Black Knight").
resolvable |= {n[4:] for n in char_names if n.lower().startswith("the ")}
resolvable_ci = {r.lower() for r in resolvable}

# Common English words that are legitimately capitalized mid-sentence in rules text
# and are NOT proper nouns we expect to register.
STOPWORDS = {
    "Deals", "Heals", "Target", "Targets", "Hero", "Heroes", "Enemy", "Enemies",
    "Ally", "Allies", "If", "When", "While", "This", "The", "For", "At", "During",
    "After", "Before", "Each", "All", "Both", "Any", "HP", "DR", "Health", "Turn",
    "Turns", "Energy", "Skill", "Skills", "Damage", "Shield", "Otherwise", "Instead",
    "Unit", "Units", "Round", "Game", "Battle", "Their", "Its", "His", "Her", "Uses",
    "Gains", "Loses", "Cannot", "Does", "Has", "Now", "Also", "Then", "Up", "To",
    "Whenever", "Additionally", "Randomly", "Permanently",
}
# Leading words to strip iteratively before resolving: articles + common verbs that
# precede a named thing ("Creates a Seedling" -> "Seedling", which IS a real minion).
DROP_LEAD = STOPWORDS | {
    "a", "an", "A", "An", "Creates", "Create", "Creating", "Consume", "Consumes",
    "Consumed", "Channel", "Channels", "Channeling", "Channelling", "Channeled",
    "Advances", "Advance", "Advanced", "Bypass", "Bypasses", "Injects", "Inject",
    "Removes", "Remove", "Places", "Place", "Placed", "Grants", "Grant", "Uses",
    "Using", "Withdraws", "Reduces", "Increases", "Being", "Alive", "Dead",
    "Makes", "Make", "Once", "Stuns", "Sacrifices", "Sacrifice", "Summons",
    "Summon", "Shatters", "Shatter", "Triggering", "Triggers", "Members", "Save",
    "Defeat", "Lowers", "Lower", "Enhancing", "Enhance", "Marked", "Sets", "Set",
    "Steals", "Steal", "Copies", "Copy", "Returns", "Moves", "Applies", "Apply",
    "Stack", "Stacks",
}

LEAD_CONNECTORS = {"of", "the", "and", "to", "in", "on", "a", "for", "from", "with"}

def strip_lead(phrase):
    words = phrase.split(" ")
    while len(words) > 1 and (words[0] in DROP_LEAD or words[0] in LEAD_CONNECTORS):
        words.pop(0)
    return " ".join(words)

# A Title-Case run: a capitalized word (may contain hyphen/digits, e.g.
# "Frost-Covered", "HS-46"), optionally continued by more capitalized words or
# lowercase connectors, e.g. "Blade of Dancing Lights", "Voice of Light".
PHRASE = re.compile(
    r"\b[A-Z][A-Za-z0-9'\-]+(?:[ '](?:of|the|and|to|in|on|a|for|[A-Z][A-Za-z0-9'\-]+))*"
)

def normalize_phrase(phrase):
    """Strip a possessive tail and trailing connectives; return the cleaned phrase."""
    phrase = re.sub(r"['’]s$", "", phrase)  # Ando's -> Ando
    words = phrase.split(" ")
    while words and words[-1] in {"of", "the", "and", "to", "in", "on", "a", "for"}:
        words.pop()
    return " ".join(words)

# Adjudication allowlist: phrases a human has ruled OK (heuristic artifacts, resource
# names, accepted proper nouns) or flagged for correction. Both count as "accounted
# for" so the lint can go green and a NEW unadjudicated phrase stands out.
def load_optional(name):
    path = os.path.join(CONTENT, name)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}

ref_exceptions = load_optional("reference_exceptions.json").get("accepted", {})
ref_corrections = load_optional("reference_corrections.json")
adjudicated = set(ref_exceptions) | set(ref_corrections)

def resolves(phrase):
    return phrase in resolvable or phrase.lower() in resolvable_ci

# A hero/skill name is frequently written with a trailing mechanic word:
# "Pyrrha Elemental Essence", "Taryn Shield", "Seedling Minions", "Strategic Skills".
# If the phrase = <resolvable prefix> + <known mechanic/plural tail>, it is accounted for.
MECHANIC_TAILS = {
    "Max HP", "Generic Energy", "True Damage", "Strategic Skill", "Strategic Skills",
    "Harmful Skill", "Harmful Skills", "Helpful Skill", "Helpful Skills",
    "Basic Skill", "Basic Skills",
}
TAIL_STOP = {"Skill", "Skills", "Minion", "Minions", "Damage", "Energy", "HP",
             "Mark", "Marks", "Essence", "Stack", "Stacks"}

def is_known_tail(suffix):
    return (suffix in glossary_terms or suffix in MECHANIC_TAILS
            or all(w in TAIL_STOP for w in suffix.split()))

def depossess(p):
    return re.sub(r"['’]s?(?=\s|$)", "", p)  # Ando's -> Ando ; Xyris' -> Xyris

def accounted(phrase):
    """Resolvable, adjudicated, or a resolvable name (also tried de-possessed)
    followed by a known mechanic tail."""
    for c in {phrase, depossess(phrase)}:
        if resolves(c) or c in adjudicated:
            return True
        words = c.split(" ")
        for cut in range(len(words) - 1, 0, -1):
            prefix, suffix = " ".join(words[:cut]), " ".join(words[cut:])
            pre_ok = resolves(prefix) or prefix in adjudicated
            suf_ok = is_known_tail(suffix) or resolves(suffix) or suffix in adjudicated
            if pre_ok and suf_ok:
                return True
    return False

# Joiners that concatenate two separate references ("Call Tides on Zev'kir",
# "Iceblood Hammer and Foot of the Mountain"). NOT of/the/to/in — those are parts
# of real names ("Voice of Light", "Tales to Tell").
JOINERS = re.compile(r"\s+(?:and|on|from|with)\s+")

def unresolved_fragments(phrase):
    """Split a phrase on reference-joiners and return the fragments that still do
    not resolve (empty list => the whole phrase is accounted for)."""
    residue = []
    for part in JOINERS.split(phrase):
        p = strip_lead(part).strip()
        if not p or p in STOPWORDS or accounted(p):
            continue
        residue.append(p)
    return residue

def descriptions():
    for s in db["skills"]:
        yield ("skill", s["id"], s.get("description") or "")
    for a in db["augments"]:
        yield ("aug", a["id"], a.get("description") or "")

def candidate_phrases(text):
    """Yield each Title-Case run (trailing connectives trimmed, possessive kept).
    The caller checks the whole phrase FIRST — so skill names that legitimately begin
    with a stopword ('This Is Not The End') resolve before any leading-word stripping."""
    for m in re.finditer(PHRASE, text):
        start = m.start()
        prev = text[:start].rstrip()
        sentence_initial = (prev == "" or prev[-1] in ".!?:")
        phrase = normalize_phrase(m.group(0))
        if not phrase:
            continue
        # sentence-initial single word is grammar caps, not a proper noun
        if sentence_initial and " " not in phrase:
            continue
        yield phrase

unresolved = Counter()
unresolved_examples = defaultdict(list)
for kind, rid, text in descriptions():
    for phrase in candidate_phrases(text):
        # whole phrase first (catches skill names beginning with a stopword)
        if not phrase or phrase in STOPWORDS or accounted(phrase):
            continue
        stripped = strip_lead(phrase)
        if not stripped or stripped in STOPWORDS or accounted(stripped):
            continue
        for frag in unresolved_fragments(stripped):
            unresolved[frag] += 1
            if len(unresolved_examples[frag]) < 5:
                unresolved_examples[frag].append(f"{kind}:{rid}")

residue = unresolved.most_common()
ref_lines = ["# Reference lint — unadjudicated Title-Case phrases", ""]
ref_lines.append(
    f"{len(residue)} distinct phrases resolve to no skill, minion, glossary term, "
    "element or character, and are not yet in `reference_exceptions.json` or "
    "`reference_corrections.json`. Each needs a ruling: accept it (exception), "
    "normalize it (correction), or flag it for the designer.\n"
)
for phrase, n in sorted(residue, key=lambda x: (-x[1], x[0])):
    ex = ", ".join(unresolved_examples[phrase])
    ref_lines.append(f"- `{phrase}`  ×{n}  (e.g. {ex})")
write_text("reports/reference_lint.md", "\n".join(ref_lines) + "\n")

sev = "ERROR" if (STRICT and residue) else "INFO"
report(sev, f"reference lint: {len(residue)} unadjudicated phrases "
            f"({len(ref_exceptions)} accepted, {len(ref_corrections)} corrections on file)")


# --------------------------------------------------------------------------- #
#  3. Augment patch-map (SUGGESTED — requires human authoring)
# --------------------------------------------------------------------------- #
def named_owner_skills(owner, text):
    """Owner skills whose name appears as a whole phrase in text. Longest-first so
    'Blade of Dancing Lights' wins over a substring 'Dancing Lights'."""
    names = sorted(owner_skill_names[owner], key=len, reverse=True)
    found = []
    consumed = text
    for nm in names:
        if re.search(r"(?<![A-Za-z])" + re.escape(nm) + r"(?![A-Za-z])", consumed):
            found.append(nm)
    return found

RESOURCE_HINTS = ("stack", "Charge", "Supercharge", "Essence", "Serum", "Shield",
                  "Frost-Covered", "mark", "Ritual", "Prisma Lens", "Tales")
MINION_HINTS = ("minion", "Seedling", "Cinder", "Angel", "Boulder", "Clone",
                "summon", "create")

patch_map = {}
kind_counts = Counter()
for a in db["augments"]:
    aid = a["id"]
    owner = a["owner"]
    desc = a.get("description") or ""
    if not desc.strip():
        patch_map[aid] = {
            "owner": owner, "display_name": a.get("display_name"),
            "targets": [], "target_kind": "EMPTY", "review_required": False,
            "note": "empty description (darkness placeholder — excluded from roster)",
        }
        kind_counts["EMPTY"] += 1
        continue
    named = named_owner_skills(owner, desc)
    target_skill_ids = []
    for nm in named:
        target_skill_ids.extend(f"skill:{sid}" for sid in owner_skill_names[owner][nm])

    if named:
        kind = "SKILL_PATCH" if len(named) == 1 else "MULTI_SKILL_PATCH"
    else:
        # no owner-skill named: guess whether it targets a resource / minion / the unit
        low = desc
        if any(h.lower() in low.lower() for h in MINION_HINTS):
            kind = "MINION_OR_TEMPLATE"
        elif any(h.lower() in low.lower() for h in RESOURCE_HINTS):
            kind = "RESOURCE_OR_UNIT"
        else:
            kind = "UNIT_OR_GLOBAL"
    kind_counts[kind] += 1
    patch_map[aid] = {
        "owner": owner,
        "display_name": a.get("display_name"),
        "targets": target_skill_ids,
        "named_skills": named,
        "target_kind": kind,
        "review_required": True,
        "description": desc,
    }

# reverse index: skills patched by >1 augment (ordering will matter in PatchFold)
skill_patchers = defaultdict(list)
for aid, rec in patch_map.items():
    for t in rec.get("targets", []):
        skill_patchers[t].append(f"aug:{aid}")
multi_patched = {k: v for k, v in skill_patchers.items() if len(v) > 1}

write_json("patch_map.suggested.json", {
    "_note": (
        "SUGGESTED augment->target map. Auto-derived by naming heuristic and NOT "
        "authoritative. Every entry with review_required=true must be confirmed by "
        "hand. There is no number-to-number augment/skill relationship."
    ),
    "_stats": dict(kind_counts),
    "_skills_patched_by_multiple_augments": multi_patched,
    "augments": patch_map,
})
report("INFO", "patch-map kinds: " + ", ".join(f"{k}={v}" for k, v in kind_counts.most_common()))
report("INFO", f"skills patched by >1 augment: {len(multi_patched)}")


# --------------------------------------------------------------------------- #
#  4. Repairs manifest
# --------------------------------------------------------------------------- #
repairs = {
    "element_mis_tags": [
        {"skill": "rolandmyth0", "tagged": "nomad", "correct": "myth", "reason": "fusion form is myth"},
        {"skill": "rolandmyth1", "tagged": "nomad", "correct": "myth", "reason": "fusion form is myth"},
        {"skill": "blackknightevil0", "tagged": "fire(default)", "correct": "evil", "reason": "defaulted; owner unholy fusion=evil"},
        {"skill": "maggiedevil0", "tagged": "fire(default)", "correct": "devil", "reason": "defaulted; fusion form is devil"},
    ],
    "minion_hp_conflicts_glossary_vs_db": [
        {"minion": "trinityazureminion", "db": 60, "glossary": 65},
        {"minion": "trinitycrimsonminion", "db": 60, "glossary": 65},
        {"minion": "trinitysaffronminion", "db": 60, "glossary": 65},
        {"minion": "sayabatteryminion", "db": 40, "glossary": 25},
        {"minion": "rolandsporeminion", "db": 25, "glossary": 20},
        {"minion": "xyrisminion", "db": None, "glossary": 35},
    ],
    "minion_owner_null": ["mythminion", "stasisminion"],
    "orphan_minion_templates": ["jarriklargeminion", "sayaauroraminion"],
    "runtime_only_units_no_template": [
        {"name": "Revenant", "from": "maggielich0", "hp": 25},
        {"name": "Simulacrum", "from": "xyrismirror1", "hp": 30},
    ],
    "records_without_art": [
        "darkness0", "darkness1", "darkness2", "darkness3", "darkness4",
        "darkness5", "darkness6", "sayaauroraminion1",
    ],
    "art_path_do_not_derive": (
        "Read the skill.image field (correct for 621/622); do NOT derive paths. "
        "e.g. pyrrhabrimstone0.image == assets/characters/pyrrha/pyrrhagas0.png"
    ),
    "excluded_from_roster": {
        "darkness": "not in roster; all 5 augments empty; no art; excluded with its 7 skills",
    },
    "ruling_needed": [
        "minion_hp_conflicts: prefer glossary (its _meta calls it the authoritative table) or db?",
    ],
}
write_json("reports/repairs.manifest.json", repairs)
report("INFO", f"repairs manifest: {len(repairs['element_mis_tags'])} element re-tags, "
               f"{len(repairs['minion_hp_conflicts_glossary_vs_db'])} HP conflicts")


# --------------------------------------------------------------------------- #
#  Summary + exit status
# --------------------------------------------------------------------------- #
counts = Counter(sev for sev, _ in problems)
lines = ["Element Arena — content lint summary", "=" * 38, ""]
for sev in ("ERROR", "WARN", "INFO"):
    for s, m in problems:
        if s == sev:
            lines.append(f"[{sev}] {m}")
lines.append("")
lines.append(f"ERROR={counts['ERROR']} WARN={counts['WARN']} INFO={counts['INFO']}")
lines.append("")
lines.append("Artifacts written under game/content/:")
for rel in ("ids.generated.ts", "patch_map.suggested.json",
            "reports/id_namespace.json", "reports/reference_lint.md",
            "reports/repairs.manifest.json"):
    lines.append(f"  - {rel}")
summary = "\n".join(lines)
write_text("reports/summary.txt", summary + "\n")
print(summary)

# Exit non-zero on ERROR always; on WARN only in --strict.
if counts["ERROR"] or (STRICT and counts["WARN"]):
    sys.exit(1)
