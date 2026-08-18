#!/usr/bin/env python3
"""
Structural validator for the P3 metagame content — fusion forms and augments.

Reuses the base-roster walkers (effect/trigger/skill/status trees) from validate_content.py,
and adds the two P3-specific shapes: a FusionForm (a fusion active skill + the fusion passive's
triggers) and an Augment (a list of Patch ops over a hero's kit). Same contract as the roster
validator: every violation is reported with a precise path, before codegen.

Usage: python game/tools/validate_p3.py [fusions.authored.json] [augments.authored.json]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import validate_content as vc  # reuse v_effect(s)/v_trigger/v_skill/v_status/v_selector + errors/err

FUSIONS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "content", "fusions.authored.json")
AUGMENTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "content", "augments.authored.json")

PATCH_OPS = {"addTrigger", "removeTrigger", "addSkill", "replaceSkill", "setSkillMeta",
             "appendEffect", "patchNode", "custom"}
SKILL_META_FIELDS = {"name", "cost", "cooldown", "tags", "targeting", "element", "klass",
                     "requires", "uncounterableIf", "channelTurns", "doesNotInterrupt"}


def v_fusion(form, path):
    for f in ("key", "hero", "element", "skill"):
        if f not in form:
            vc.err(path, f"fusion form missing '{f}'")
    if form.get("passiveMode") and form["passiveMode"] not in {"replace", "add"}:
        vc.err(path, f"invalid passiveMode '{form['passiveMode']}'")
    if isinstance(form.get("skill"), dict):
        vc.v_skill(form["skill"], path + ".skill")
    for i, t in enumerate(form.get("passiveTriggers", []) or []):
        vc.v_trigger(t, f"{path}.passiveTriggers[{i}]")


def v_patch(p, path):
    if not isinstance(p, dict):
        vc.err(path, "patch must be an object")
        return
    op = p.get("op")
    if op not in PATCH_OPS:
        vc.err(path, f"invalid patch op '{op}'")
        return
    if op == "addTrigger":
        vc.v_trigger(p.get("trigger", {}), path + ".trigger")
    elif op == "removeTrigger":
        if "source" not in p:
            vc.err(path, "removeTrigger missing 'source'")
    elif op in ("addSkill", "replaceSkill"):
        if op == "replaceSkill" and "skillId" not in p:
            vc.err(path, "replaceSkill missing 'skillId'")
        if isinstance(p.get("skill"), dict):
            vc.v_skill(p["skill"], path + ".skill")
        else:
            vc.err(path, f"{op} missing 'skill'")
    elif op == "setSkillMeta":
        if "skillId" not in p:
            vc.err(path, "setSkillMeta missing 'skillId'")
        meta = p.get("meta", {})
        if not isinstance(meta, dict):
            vc.err(path, "setSkillMeta 'meta' must be an object")
        else:
            for k in meta:
                if k not in SKILL_META_FIELDS:
                    vc.err(path + ".meta", f"unknown skill meta field '{k}'")
            if "requires" in meta:
                vc.v_condition(meta["requires"], path + ".meta.requires")
            if "uncounterableIf" in meta:
                vc.v_condition(meta["uncounterableIf"], path + ".meta.uncounterableIf")
    elif op == "appendEffect":
        if "skillId" not in p:
            vc.err(path, "appendEffect missing 'skillId'")
        vc.v_effects(p.get("effect", []), path + ".effect")
    elif op == "patchNode":
        for f in ("skillId", "nodeId", "replace"):
            if f not in p:
                vc.err(path, f"patchNode missing '{f}'")
        if isinstance(p.get("replace"), dict):
            vc.v_effect(p["replace"], path + ".replace")
    # custom: fn required
    elif op == "custom" and "fn" not in p:
        vc.err(path, "custom patch missing 'fn'")


def v_augment(aug, path):
    for f in ("id", "name", "patches"):
        if f not in aug:
            vc.err(path, f"augment missing '{f}'")
    for i, p in enumerate(aug.get("patches", []) or []):
        v_patch(p, f"{path}.patches[{i}]")


def load(pathname):
    if not os.path.exists(pathname):
        return None
    return json.load(open(pathname, encoding="utf-8"))


def main():
    forms_data = load(FUSIONS)
    augs_data = load(AUGMENTS)
    n_forms = n_augs = 0

    if forms_data is not None:
        forms = forms_data.get("forms", forms_data) if isinstance(forms_data, dict) else forms_data
        n_forms = len(forms)
        for f in forms:
            v_fusion(f, f"fusion({f.get('hero','?')}:{f.get('key','?')})")
    else:
        print(f"(no fusions file at {FUSIONS})")

    if augs_data is not None:
        augs = augs_data.get("augments", augs_data) if isinstance(augs_data, dict) else augs_data
        n_augs = len(augs)
        for a in augs:
            v_augment(a, f"augment({a.get('id','?')})")
    else:
        print(f"(no augments file at {AUGMENTS})")

    print(f"validated {n_forms} fusion forms, {n_augs} augments")
    print(f"\nTOTAL structural errors: {len(vc.errors)}")
    for e in vc.errors[:120]:
        print("  " + e)
    if len(vc.errors) > 120:
        print(f"  ... and {len(vc.errors) - 120} more")
    sys.exit(1 if vc.errors else 0)


if __name__ == "__main__":
    main()
