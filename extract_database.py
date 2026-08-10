"""
extract_database.py - build a clean, engine-independent JSON database from the
Godot project's .tscn / .tres / .gd source.

Run:   python data_export/extract_database.py

Writes to data_export/output/:
    database.json      - everything, plus a _meta block with counts & warnings
    elements.json, fusion_recipes.json, characters.json, skills.json,
    augments.json, masteries.json, minions.json   - per-domain slices

Design notes
------------
* All structured data (name, element, cost, cooldown, classes, description,
  targeting, images) comes from the .tscn / .tres files via godot_parser -
  a real parser, not field regex.
* The element system and fusion recipes come from element.gd (elements.py).
* Roster metadata (display order, bot flag, fusion/augment eligibility, titles)
  comes from character_database.gd (metadata.py).
* Minion base HP is *not* stored as data anywhere - it is assigned in GDScript
  spawn code. We recover it with a best-effort text scan and tag every value
  with hp_source="gd-heuristic" so consumers know it is derived, not canonical.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import elements as elements_mod
import metadata as metadata_mod
from godot_parser import parse_file

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "output"

# Ability.TargetingType (components/ability/ability.gd)
TARGETING = ["single", "self", "all", "all_faction", "battle", "count"]
# Ability.classes default key set (address_legacy_states backfills the last two)
CLASS_KEYS = [
    "Harmful", "Helpful", "Strategic", "Instant", "Control", "Channel",
    "Uncounterable", "Bypassing", "Passive", "Affliction", "Unstunnable",
]
MASTERY_ROLES = ["attacker", "defender", "support", "disruptor", "strategist"]

warnings: list[str] = []
info: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)


def note(msg: str) -> None:
    info.append(msg)


def rel(path: str | None) -> str | None:
    """Normalise a res:// path to a repo-relative path."""
    if not path:
        return None
    return path.replace("res://", "")


def stem(p: Path) -> str:
    return p.stem


# --------------------------------------------------------------------------- #
#  Element helpers
# --------------------------------------------------------------------------- #

def build_elements() -> dict[str, Any]:
    data = elements_mod.build(ROOT / "components" / "types" / "element.gd")
    return data


def el_ref(elements_by_id: dict[int, dict], eid: Any,
           context: str | None = None) -> dict[str, Any] | None:
    """
    Build an element reference. A .tscn that omits `element` leaves Godot's
    typed `@export var element: Element.Type` at its enum default - the first
    member, FIRE (0) - so we resolve an omitted element to FIRE and flag it
    `defaulted`, exactly as resolve_targeting() does for _targeting_type.
    """
    if eid is None:
        e = elements_by_id[0]  # FIRE
        if context:
            note(f"{context}: element omitted in source, defaulted to "
                 f"{e['name']} (Godot enum default)")
        return {"id": 0, "name": e["name"], "display_name": e["display_name"],
                "defaulted": True}
    e = elements_by_id.get(eid)
    if e is None:
        warn(f"element id {eid!r} not in Element.Type enum" +
             (f" ({context})" if context else ""))
        return {"id": eid, "name": None}
    return {"id": eid, "name": e["name"], "display_name": e["display_name"]}


# --------------------------------------------------------------------------- #
#  Skills
# --------------------------------------------------------------------------- #

def normalise_classes(raw: Any) -> tuple[dict[str, bool], list[str]]:
    full = {k: False for k in CLASS_KEYS}
    if isinstance(raw, dict):
        for k, v in raw.items():
            full[k] = bool(v)
            if k not in full:
                # unexpected class key - keep it but flag
                warn(f"unexpected skill class key {k!r}")
    active = [k for k, v in full.items() if v]
    return full, active


def resolve_targeting(targeting_id: Any, is_passive: bool) -> dict[str, Any] | None:
    """
    Map _targeting_type to {id, name}. Passives have no targeting (None).
    A non-passive with no explicit value falls back to Godot's enum default,
    SINGLE (0), and is flagged `defaulted` so the rewrite knows it was implicit.
    """
    if targeting_id is None:
        if is_passive:
            return None
        return {"id": 0, "name": TARGETING[0], "defaulted": True}
    name = TARGETING[targeting_id] if 0 <= targeting_id < len(TARGETING) else None
    return {"id": targeting_id, "name": name}


def normalise_cost(raw: Any) -> dict[str, int]:
    generic = specific = 0
    if isinstance(raw, dict):
        generic = int(raw.get("GENERIC", 0) or 0)
        specific = int(raw.get("SPECIFIC", 0) or 0)
    return {"generic": generic, "specific": specific}


def classify_skill(skill_id: str, owner: str, element_names: set[str],
                   is_minion: bool) -> dict[str, Any]:
    """Work out whether a skill file is a base skill or a fusion skill."""
    info: dict[str, Any] = {"kind": "minion" if is_minion else "unknown"}
    if is_minion:
        info["kind"] = "minion"
        return info

    m = re.fullmatch(rf"{re.escape(owner)}(\d+)", skill_id)
    if m:
        info["kind"] = "base"
        info["slot"] = int(m.group(1))
        return info

    m = re.fullmatch(rf"{re.escape(owner)}([A-Za-z]+)(\d+)", skill_id)
    if m:
        suffix, slot = m.group(1), int(m.group(2))
        if suffix.lower() in element_names:
            info["kind"] = "fusion"
            info["fusion_element"] = suffix.lower()
            info["slot"] = slot  # 0 = fusion passive, 1 = fusion active
            return info
        # e.g. andoX0/andoX1: an alternate ("variant") form of a base skill
        info["kind"] = "variant"
        info["variant"] = suffix
        info["slot"] = slot
        note(f"variant skill {skill_id!r} (owner {owner!r}, variant {suffix!r})")
        return info

    warn(f"could not classify skill {skill_id!r} for owner {owner!r}")
    return info


def extract_skills(elements_by_id: dict[int, dict], element_names: set[str]) -> list[dict]:
    skills: list[dict] = []
    skills_root = ROOT / "skills"
    for owner_dir in sorted(p for p in skills_root.iterdir() if p.is_dir()):
        owner = owner_dir.name
        tscn_files = sorted(owner_dir.glob("*.tscn"))
        minion_files = sorted((owner_dir / "minions").glob("*.tscn")) \
            if (owner_dir / "minions").is_dir() else []
        for f, is_minion in [(x, False) for x in tscn_files] + \
                            [(x, True) for x in minion_files]:
            res = parse_file(f)
            props = res.resolved_properties()
            sid = stem(f)
            classes_full, classes_active = normalise_classes(props.get("classes"))
            is_passive = classes_full.get("Passive", False)
            targeting = resolve_targeting(props.get("_targeting_type"), is_passive)
            skill = {
                "id": sid,
                "owner": owner,
                "name": props.get("ability_name"),
                "element": el_ref(elements_by_id, props.get("element"), f"skill {sid}"),
                "description": props.get("description"),
                "cost": normalise_cost(props.get("cost")),
                "cooldown": int(props.get("cooldown") or 0),
                "targeting_type": targeting,
                "is_passive": is_passive,
                "hidden": bool(props.get("hidden") or False),
                "hidden_targets": bool(props.get("hidden_targets") or False),
                "priority": props.get("priority", 100),
                "classes": classes_full,
                "classes_active": classes_active,
                "is_minion_skill": is_minion,
                "image": rel(props.get("image")),
                "source_file": str(f.relative_to(ROOT)).replace("\\", "/"),
            }
            skill.update({"classification": classify_skill(sid, owner, element_names, is_minion)})
            if skill["name"] is None:
                warn(f"skill {sid!r} has no ability_name")
            skills.append(skill)
    return skills


# --------------------------------------------------------------------------- #
#  Augments
# --------------------------------------------------------------------------- #

def extract_augments(elements_by_id: dict[int, dict]) -> list[dict]:
    augs: list[dict] = []
    for owner_dir in sorted(p for p in (ROOT / "augments").iterdir() if p.is_dir()):
        owner = owner_dir.name
        for f in sorted(owner_dir.glob("*.tscn")):
            props = parse_file(f).resolved_properties()
            name = props.get("augment_name") or stem(f)
            idx_m = re.search(r"(\d+)$", stem(f))
            augs.append({
                "id": stem(f),
                "owner": owner,
                "augment_name": name,
                "display_name": props.get("display_name"),
                "description": props.get("description"),
                "element": el_ref(elements_by_id, props.get("element"), f"augment {stem(f)}"),
                "index": int(idx_m.group(1)) if idx_m else None,
                "deploy_mark": bool(props.get("deploy_mark", True)),
                "source_file": str(f.relative_to(ROOT)).replace("\\", "/"),
            })
    return augs


# --------------------------------------------------------------------------- #
#  Masteries
# --------------------------------------------------------------------------- #

def extract_masteries() -> list[dict]:
    out: list[dict] = []
    for owner_dir in sorted(p for p in (ROOT / "masteries").iterdir() if p.is_dir()):
        owner = owner_dir.name
        for f in sorted(owner_dir.glob("*.tscn")):
            props = parse_file(f).resolved_properties()
            role = stem(f).replace("mastery", "")
            out.append({
                "id": f"{owner}_{role}",
                "owner": owner,
                "role": role,
                "mastery_name": props.get("mastery_name"),
                "progress_multiplier": props.get("progress_multiplier"),
                "progress_increment": props.get("progress_increment"),
                "type": props.get("type"),
                "source_file": str(f.relative_to(ROOT)).replace("\\", "/"),
            })
            if role not in MASTERY_ROLES:
                warn(f"unexpected mastery role {role!r} in {owner}")
    return out


# --------------------------------------------------------------------------- #
#  Minion HP heuristic (best-effort, from GDScript spawn code)
# --------------------------------------------------------------------------- #

def scan_minion_hp() -> tuple[dict[str, list[int]], set[str]]:
    """
    Recover minion base HP from GDScript. Patterns recognised:
      (a) create_minion(user, target, "minionpath", 50)      -> 50
      (b) load("res://characters/minions/minionpath.tscn")...
              <var>.max_hp = 40        (literal, within a few lines)
              <var>.max_hp = some_var  ; some_var = 25   (one hop back to a literal)

    Returns (candidates, dynamic) where `dynamic` is the set of minions that DO
    get a max_hp assignment but from a runtime expression (e.g. `user.hp`), so
    their HP is intentionally not a fixed number.
    """
    candidates: dict[str, list[int]] = defaultdict(list)
    dynamic: set[str] = set()
    gd_files = list((ROOT / "characters").rglob("*.gd")) + \
               list((ROOT / "augments").rglob("*.gd")) + \
               list((ROOT / "skills").rglob("*.gd"))

    load_re = re.compile(r'load\("res://characters/minions/(\w+)\.tscn"\)')
    create_re = re.compile(r'create_minion\([^,]+,[^,]+,\s*"(\w+)"\s*,\s*(\d+)\)')

    for gd in gd_files:
        try:
            lines = gd.read_text(encoding="utf-8").splitlines()
        except Exception as exc:  # pragma: no cover
            warn(f"could not read {gd}: {exc}")
            continue

        for i, line in enumerate(lines):
            for cm in create_re.finditer(line):
                candidates[cm.group(1)].append(int(cm.group(2)))

            for lm in load_re.finditer(line):
                minion = lm.group(1)
                window = lines[i:i + 8]
                found = False
                assigned_expr = False
                for w in window:
                    hm = re.search(r"\.max_hp\s*=\s*(\d+)", w)
                    if hm:
                        candidates[minion].append(int(hm.group(1)))
                        found = True
                        break
                if not found:
                    # one hop: max_hp = VAR ; look back for VAR = INT
                    for w in window:
                        vm = re.search(r"\.max_hp\s*=\s*([A-Za-z_]\w*)", w)
                        if vm:
                            assigned_expr = True
                            var = vm.group(1)
                            for back in lines[max(0, i - 8):i + 8]:
                                bm = re.search(rf"\b{re.escape(var)}\s*=\s*(\d+)\b", back)
                                if bm:
                                    candidates[minion].append(int(bm.group(1)))
                                    found = True
                                    break
                            break
                if assigned_expr and not found:
                    dynamic.add(minion)

    # dedupe preserving order
    out: dict[str, list[int]] = {}
    for k, v in candidates.items():
        seen: list[int] = []
        for x in v:
            if x not in seen:
                seen.append(x)
        out[k] = seen
    return out, dynamic


# --------------------------------------------------------------------------- #
#  Minions
# --------------------------------------------------------------------------- #

def guess_owner(path_name: str, roster: list[str]) -> str | None:
    """Longest roster path that prefixes the minion's path_name."""
    best = None
    for c in roster:
        if path_name.startswith(c) and (best is None or len(c) > len(best)):
            best = c
    return best


def extract_minions(elements_by_id: dict[int, dict], roster: list[str],
                    hp_candidates: dict[str, list[int]],
                    dynamic_hp: set[str]) -> list[dict]:
    out: list[dict] = []
    for f in sorted((ROOT / "characters" / "minions").glob("*.tscn")):
        props = parse_file(f).resolved_properties()
        path_name = props.get("path_name") or stem(f)
        cands = hp_candidates.get(path_name, [])
        if cands:
            hp_source = "gd-heuristic"
        elif path_name in dynamic_hp:
            hp_source = "dynamic"          # HP set from a runtime expression
        else:
            hp_source = None               # not found
        out.append({
            "id": path_name,
            "character_name": props.get("character_name"),
            "path_name": path_name,
            "owner": guess_owner(path_name, roster),
            "element": el_ref(elements_by_id, props.get("element"), f"minion {path_name}"),
            "image": rel(props.get("image")),
            "base_hp": cands[0] if cands else None,
            "base_hp_candidates": cands,
            "hp_source": hp_source,
            "source_file": str(f.relative_to(ROOT)).replace("\\", "/"),
        })
        if hp_source == "dynamic":
            note(f"minion {path_name!r} has dynamic HP (set from a runtime expression)")
        elif hp_source is None:
            note(f"no base HP found for minion {path_name!r} (may be display-only or spawned indirectly)")
    return out


# --------------------------------------------------------------------------- #
#  Characters
# --------------------------------------------------------------------------- #

def extract_characters(elements_by_id: dict[int, dict], meta: dict,
                       skills: list[dict], augments: list[dict],
                       masteries: list[dict]) -> list[dict]:
    roster = meta["roster"]
    tres_by_path = {}
    for tres in (ROOT / "characters").glob("*.tres"):
        if tres.stem == "character_resource":
            continue
        p = parse_file(tres).resolved_properties()
        if p.get("path_name"):
            tres_by_path[p["path_name"]] = p

    skills_by_owner: dict[str, list[dict]] = defaultdict(list)
    for s in skills:
        skills_by_owner[s["owner"]].append(s)
    augs_by_owner: dict[str, list[dict]] = defaultdict(list)
    for a in augments:
        augs_by_owner[a["owner"]].append(a)
    mast_by_owner: dict[str, list[dict]] = defaultdict(list)
    for m in masteries:
        mast_by_owner[m["owner"]].append(m)

    out: list[dict] = []
    for f in sorted((ROOT / "characters").glob("*.tscn")):
        if stem(f) in ("character_template",):
            continue
        props = parse_file(f).resolved_properties()
        path = props.get("path_name") or stem(f)
        eid = props.get("element")
        starts_fused = isinstance(eid, int) and eid >= elements_mod.BASE_COUNT

        owner_skills = skills_by_owner.get(path, [])
        base_skills = sorted(
            (s for s in owner_skills if s["classification"].get("kind") == "base"),
            key=lambda s: s["classification"].get("slot", 0),
        )
        fusion_skills: dict[str, dict[str, str]] = defaultdict(dict)
        for s in owner_skills:
            c = s["classification"]
            if c.get("kind") == "fusion":
                slot = "passive" if c.get("slot") == 0 else "active"
                fusion_skills[c["fusion_element"]][slot] = s["id"]

        mastery_multipliers = {
            m["role"]: m["progress_multiplier"] for m in mast_by_owner.get(path, [])
        }

        record = {
            "id": path,
            "path_name": path,
            "character_name": props.get("character_name"),
            "short_name": meta["short_names"].get(path),
            "element": el_ref(elements_by_id, eid, f"character {path}"),
            "starts_fused": starts_fused,
            "can_fuse": (not starts_fused) and path not in meta["no_fusion_characters"],
            "can_augment": path not in meta["no_augment_characters"],
            "in_roster": path in roster,
            "roster_index": roster.index(path) if path in roster else None,
            "is_bot": path in meta["bot_characters"],
            "titles": {
                "minor": meta["minor_titles"].get(path, []),
                "middle": meta["middle_titles"].get(path, []),
                "major": meta["major_titles"].get(path, []),
            },
            "image": rel(props.get("image")),
            "base_skill_ids": [s["id"] for s in base_skills],
            "fusion_skills": {k: dict(v) for k, v in sorted(fusion_skills.items())},
            "augment_ids": [a["id"] for a in sorted(augs_by_owner.get(path, []),
                                                    key=lambda a: a.get("index") or 0)],
            "mastery_multipliers": mastery_multipliers,
            "source_file": str(f.relative_to(ROOT)).replace("\\", "/"),
        }
        if path in tres_by_path:
            t = tres_by_path[path]
            record["resource_extras"] = {
                "display_name": t.get("display_name"),
                "character_type": t.get("character_type"),
                "initial_element": t.get("initial_element"),
            }
        out.append(record)

        # --- per-character consistency checks -------------------------------
        if path in roster:
            expected_base = 4 if path == "trinity" else (7 if starts_fused else 6)
            if len(base_skills) != expected_base:
                warn(f"{path}: expected {expected_base} base skills, found {len(base_skills)}")
            if len(mast_by_owner.get(path, [])) != 5:
                warn(f"{path}: expected 5 masteries, found {len(mast_by_owner.get(path, []))}")
            if record["can_fuse"]:
                if not fusion_skills:
                    warn(f"{path}: fuseable but no fusion skills found")
                elif len(fusion_skills) != elements_mod.BASE_COUNT:
                    note(f"{path}: {len(fusion_skills)} fusion elements found "
                         f"(a base element combines with {elements_mod.BASE_COUNT})")
    return out


# --------------------------------------------------------------------------- #
#  Orchestration
# --------------------------------------------------------------------------- #

def main() -> None:
    OUT.mkdir(exist_ok=True)

    el_data = build_elements()
    elements = el_data["elements"]
    elements_by_id = {e["id"]: e for e in elements}
    element_names = {e["name"] for e in elements}
    fusion_recipes = el_data["fusion_recipes"]

    meta = metadata_mod.build(ROOT / "components" / "character" / "character_database.gd")

    skills = extract_skills(elements_by_id, element_names)
    augments = extract_augments(elements_by_id)
    masteries = extract_masteries()
    hp_candidates, dynamic_hp = scan_minion_hp()
    minions = extract_minions(elements_by_id, meta["roster"], hp_candidates, dynamic_hp)
    characters = extract_characters(elements_by_id, meta, skills, augments, masteries)

    counts = {
        "elements": len(elements),
        "fusion_recipes": len(fusion_recipes),
        "characters": len(characters),
        "characters_in_roster": sum(1 for c in characters if c["in_roster"]),
        "skills": len(skills),
        "skills_character": sum(1 for s in skills if not s["is_minion_skill"]),
        "skills_minion": sum(1 for s in skills if s["is_minion_skill"]),
        "augments": len(augments),
        "masteries": len(masteries),
        "minions": len(minions),
        "minions_with_hp": sum(1 for m in minions if m["base_hp"] is not None),
    }

    database = {
        "_meta": {
            "generator": "data_export/extract_database.py",
            "source_root": str(ROOT.name),
            "description": "Engine-independent export of Anima Arena game data.",
            "counts": counts,
            "roster": meta["roster"],
            "warnings": warnings,
            "warning_count": len(warnings),
            "info": info,
            "notes": [
                "All costs/cooldowns/classes/descriptions come from the .tscn files.",
                "Element ids follow Element.Type in components/types/element.gd.",
                "Minion base_hp is heuristically recovered from GDScript spawn code "
                "(hp_source='gd-heuristic'); base_hp_candidates lists every value found.",
                "Character base HP is a uniform 100 (Character class default; not per-character data).",
            ],
        },
        "elements": elements,
        "fusion_recipes": fusion_recipes,
        "characters": characters,
        "skills": skills,
        "augments": augments,
        "masteries": masteries,
        "minions": minions,
    }

    def dump(name: str, obj: Any) -> None:
        (OUT / name).write_text(
            json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    dump("database.json", database)
    dump("elements.json", {"elements": elements, "fusion_recipes": fusion_recipes})
    dump("fusion_recipes.json", fusion_recipes)
    dump("characters.json", characters)
    dump("skills.json", skills)
    dump("augments.json", augments)
    dump("masteries.json", masteries)
    dump("minions.json", minions)

    print("Extraction complete. Output ->", OUT)
    for k, v in counts.items():
        print(f"  {k:24} {v}")
    print(f"\n  warnings: {len(warnings)}")
    for w in warnings:
        print("   -", w)
    print(f"\n  info notes: {len(info)} (see database.json _meta.info)")


if __name__ == "__main__":
    main()
