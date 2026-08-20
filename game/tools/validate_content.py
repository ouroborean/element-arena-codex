#!/usr/bin/env python3
"""
Structural validator for authored roster content (game/content/roster.authored.json).

The engine's DSL is a strict discriminated union; agent-authored JSON must use exact op /
status-kind / selector / condition / value spellings and required fields. This walks every
effect/value/selector/condition/status tree and reports each violation with a precise path,
so authoring errors are caught deterministically before codegen — the fast half of the
"compilation is the oracle" pipeline (the runtime smoke test is the other half).

Vocabulary below is verified against game/engine/src/{effects/ast.ts,types.ts,events.ts}.
Usage: python game/tools/validate_content.py [roster.authored.json]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROSTER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "content", "roster.authored.json")

EFFECT_OPS = {"damage", "heal", "healthLoss", "grantShield", "applyStatus", "removeStatus",
              "modifyStatus", "addStack", "grantEnergy", "modifyCooldown", "summon", "revive",
              "defeat", "transform", "useSkill", "swapPositions", "shuffleTeam", "if", "forEach",
              "seq", "schedule", "custom"}
VALUE_REFS = {"stackCount", "missingHp", "currentHp", "shield", "spendableShield", "count", "statusDuration", "statusMag", "statusCount", "sum", "var"}
VALUE_OPS = {"add", "sub", "mul", "min", "max", "div"}
SELECTOR_STRINGS = {"self", "caster", "target", "summoner", "it", "across", "adjacent",
                    "eventSource", "eventTarget", "eventTargets", "eventUnit"}
STATUS_KINDS = {"damage_reduction", "incoming_damage_mod", "outgoing_damage_mod",
                "incoming_damage_mult", "outgoing_damage_mult",
                "outgoing_dtype_override", "conditional_bypass",
                "shield_absorb_cap", "split_incoming", "shield_grant_bonus", "shield_non_absorbing", "skill_damage_bonus", "skill_targeting_override",
                "damage_becomes_heal", "heal_becomes_damage", "dies_at_max", "shatter",
                "damage_ignore", "non_damage_ignore", "immortal", "revive_ward", "invulnerable",
                "isolated", "untargetable", "elemental_essence", "cost_mod", "cost_currency_remap", "silence", "paralysis",
                "stealth", "veiled", "taunt", "blind", "stun", "channeling", "dot", "regen",
                "heal_lock", "uncounterable", "coil_damage_bonus", "mark", "stack"}
EVENTS = {"damageDealt", "shieldDamaged", "shieldBroken", "unitDied", "skillUsed", "skillDeclared",
          "skillGranted", "minionSummoned", "healReceived", "statusApplied", "statusExpired", "skillRedirected",
          "counterFired", "energyFromEssence", "turnStart", "turnEnd", "roundStart", "statusLost"}
TARGETING = {"single", "self", "all-enemies", "all-allies", "all", "none"}
KLASS = {"basic", "defensive", "ultimate", "fusion", "passive"}
DTYPES = {"normal", "piercing", "affliction", "true"}

EFFECT_LIST_KEYS = {"then", "else", "do", "steps", "effect"}
SELECTOR_KEYS = {"to", "from", "of", "by", "on", "a", "b", "each", "redirectTo"}
VALUE_KEYS = {"amount", "hp", "delta", "magnitudeDelta", "durationDelta", "count", "num"}
REQUIRED = {
    "damage": ["amount"], "heal": ["amount"], "healthLoss": ["amount"], "grantShield": ["amount"],
    "applyStatus": ["status"], "removeStatus": ["kind"], "modifyStatus": ["kind"], "addStack": ["name"],
    "grantEnergy": ["element", "amount"], "modifyCooldown": ["delta"], "summon": ["template"],
    "revive": ["hp"], "transform": ["template"], "useSkill": ["skillId"], "swapPositions": ["a", "b"],
    "if": ["cond", "then"], "forEach": ["each", "do"], "seq": ["steps"],
    "schedule": ["delayTurns", "effect"], "custom": ["fn"],
}

errors = []
def err(path, msg):
    errors.append(f"{path}: {msg}")

def v_value(v, path):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return
    if isinstance(v, dict):
        if "ref" in v:
            if v["ref"] not in VALUE_REFS:
                err(path, f"invalid value ref '{v['ref']}'")
            if v.get("ref") == "sum" and v.get("metric") not in {"missingHp", "currentHp", "shield"}:
                err(path, f"invalid sum metric '{v.get('metric')}' (only missingHp/currentHp/shield)")
            if v.get("ref") == "var" and "of" in v:
                err(path, "value ref 'var' takes no 'of'")
            if "of" in v and v.get("ref") != "var":
                v_selector(v["of"], path + ".of")
        elif "op" in v:
            if v["op"] not in VALUE_OPS:
                err(path, f"invalid value op '{v['op']}'")
            for i, a in enumerate(v.get("args", [])):
                v_value(a, f"{path}.args[{i}]")
            if "num" in v:
                v_value(v["num"], path + ".num")
        else:
            err(path, f"value object missing ref/op: {list(v.keys())}")
        return
    err(path, f"value must be number or object, got {type(v).__name__}")

def v_selector(s, path):
    if isinstance(s, str):
        if s not in SELECTOR_STRINGS:
            err(path, f"invalid selector '{s}'")
        return
    if isinstance(s, dict):
        if "faction" in s:
            if s["faction"] not in {"allies", "enemies", "all"}:
                err(path, f"invalid faction '{s['faction']}'")
            if s.get("kind") and s["kind"] not in {"hero", "minion"}:
                err(path, f"invalid selector kind '{s['kind']}'")
        elif "pick" in s:
            if s["pick"] not in {"random", "lowestHp", "highestHp"}:
                err(path, f"invalid pick '{s['pick']}'")
            if "from" in s:
                v_selector(s["from"], path + ".from")
        elif "filter" in s:
            v_selector(s["filter"], path + ".filter")
            for k in ("with", "without"):
                if k in s:
                    m = s[k]
                    kind = m if isinstance(m, str) else m.get("kind")
                    if kind not in STATUS_KINDS:
                        err(f"{path}.{k}", f"invalid status kind '{kind}'")
        else:
            err(path, f"unrecognized selector object: {list(s.keys())}")
        return
    err(path, "selector must be string or object")

def v_condition(c, path):
    if not isinstance(c, dict):
        err(path, "condition must be an object")
        return
    if "has" in c:
        if c["has"] not in STATUS_KINDS:
            err(path, f"invalid status kind '{c['has']}'")
        if "of" in c:
            v_selector(c["of"], path + ".of")
    elif "cmp" in c:
        v_value(c.get("left"), path + ".left")
        v_value(c.get("right"), path + ".right")
    elif "sameUnit" in c:
        for i, sel in enumerate(c["sameUnit"]):
            v_selector(sel, f"{path}.sameUnit[{i}]")
    elif "isFaction" in c:
        v_selector(c["isFaction"], path + ".isFaction")
        if c.get("faction") not in {"ally", "enemy"}:
            err(path, f"invalid isFaction '{c.get('faction')}'")
    elif "isKind" in c:
        v_selector(c["isKind"], path + ".isKind")
        if c.get("kind") not in {"hero", "minion"}:
            err(path, f"invalid isKind '{c.get('kind')}'")
    elif "skillOnCooldown" in c:
        if not isinstance(c["skillOnCooldown"], str):
            err(path, "skillOnCooldown must be a skill id string")
    elif "declaredTargetsSelf" in c or "eventHasTag" in c or "eventStatusKind" in c or "eventTeamIsSelf" in c or "eventRedirectedToSelf" in c or "eventHidden" in c or "chance" in c:
        pass
    elif "and" in c:
        for i, x in enumerate(c["and"]):
            v_condition(x, f"{path}.and[{i}]")
    elif "or" in c:
        for i, x in enumerate(c["or"]):
            v_condition(x, f"{path}.or[{i}]")
    elif "not" in c:
        v_condition(c["not"], path + ".not")
    else:
        err(path, f"unrecognized condition: {list(c.keys())}")

def v_status(st, path):
    if not isinstance(st, dict):
        err(path, "status must be an object")
        return
    if st.get("kind") not in STATUS_KINDS:
        err(path, f"invalid status kind '{st.get('kind')}'")
    if "duration" not in st:
        err(path, "status missing 'duration' (use null for permanent)")
    elif st["duration"] is not None:
        v_value(st["duration"], path + ".duration")
    if "magnitude" in st:
        v_value(st["magnitude"], path + ".magnitude")
    if "unitRef" in st:
        v_selector(st["unitRef"], path + ".unitRef")
    if "dtype" in st and st["dtype"] not in DTYPES:
        err(path, f"invalid dtype '{st['dtype']}'")
    if "onExpire" in st:
        v_effects(st["onExpire"], path + ".onExpire")
    if "scope" in st and isinstance(st["scope"], dict):
        if st["scope"].get("mode") not in {"only", "except"}:
            err(path + ".scope", f"invalid stun scope mode '{st['scope'].get('mode')}'")

def v_effect(e, path):
    if not isinstance(e, dict):
        err(path, "effect must be an object")
        return
    op = e.get("op")
    if op not in EFFECT_OPS:
        err(path, f"invalid effect op '{op}'")
        return
    for r in REQUIRED.get(op, []):
        if r not in e:
            err(path, f"{op} missing required '{r}'")
    if "dtype" in e and e["dtype"] not in DTYPES:
        err(path, f"invalid dtype '{e['dtype']}'")
    for k, val in e.items():
        if k in EFFECT_LIST_KEYS:
            v_effects(val, f"{path}.{k}")
        elif k in SELECTOR_KEYS:
            v_selector(val, f"{path}.{k}")
        elif k in VALUE_KEYS:
            v_value(val, f"{path}.{k}")
        elif k in ("cond", "when"):
            v_condition(val, f"{path}.{k}")
        elif k == "status":
            v_status(val, f"{path}.status")
        elif k == "kind" and op in ("modifyStatus", "removeStatus"):
            if val not in STATUS_KINDS:
                err(path, f"invalid status kind '{val}'")

def v_effects(lst, path):
    if not isinstance(lst, list):
        err(path, "expected an effect array")
        return
    for i, e in enumerate(lst):
        v_effect(e, f"{path}[{i}]")

def v_trigger(t, path):
    if not isinstance(t, dict):
        err(path, "trigger must be an object")
        return
    if t.get("on") not in EVENTS:
        err(path, f"invalid trigger event '{t.get('on')}'")
    if t.get("kind") and t["kind"] not in {"react", "counter", "reflect", "replace"}:
        err(path, f"invalid trigger kind '{t['kind']}'")
    if "when" in t:
        v_condition(t["when"], path + ".when")
    v_effects(t.get("effect", []), path + ".effect")
    if "redirectTo" in t:
        v_selector(t["redirectTo"], path + ".redirectTo")

def v_skill(s, path):
    if s.get("targeting") not in TARGETING:
        err(path, f"invalid targeting '{s.get('targeting')}'")
    if s.get("klass") not in KLASS:
        err(path, f"invalid klass '{s.get('klass')}'")
    cost = s.get("cost", {})
    if not isinstance(cost, dict) or "generic" not in cost or "specific" not in cost:
        err(path, "cost must be {generic, specific}")
    if not isinstance(s.get("cooldown"), (int, float)):
        err(path, "cooldown must be a number")
    if "requires" in s:
        v_condition(s["requires"], path + ".requires")
    for i, m in enumerate(s.get("costMods", []) or []):
        mp = f"{path}.costMods[{i}]"
        if "magnitude" not in m:
            err(mp, "costMod needs a magnitude")
        elif not (isinstance(m["magnitude"], (int, float)) and not isinstance(m["magnitude"], bool)):
            v_value(m["magnitude"], mp + ".magnitude")  # bool excluded: a non-numeric magnitude must be a Value
        if "when" in m:
            v_condition(m["when"], mp + ".when")
    v_effects(s.get("effects", []), path + ".effects")

def v_minion(m, path):
    if not isinstance(m.get("maxHp"), (int, float)):
        err(path, "minion maxHp must be a number")
    for i, s in enumerate(m.get("skills", []) or []):
        v_skill(s, f"{path}.skills[{i}]({s.get('id')})")
    for i, t in enumerate(m.get("triggers", []) or []):
        v_trigger(t, f"{path}.triggers[{i}]")

def v_hero(h):
    hid = h.get("id", "?")
    p = f"hero({hid})"
    for f in ("id", "name", "element", "maxHp"):
        if f not in h:
            err(p, f"missing '{f}'")
    for i, s in enumerate(h.get("skills", []) or []):
        v_skill(s, f"{p}.skills[{i}]({s.get('id')})")
    for i, t in enumerate(h.get("triggers", []) or []):
        v_trigger(t, f"{p}.triggers[{i}]")
    pas = h.get("passive")
    if isinstance(pas, dict) and isinstance(pas.get("trigger"), dict):
        v_trigger(pas["trigger"], f"{p}.passive.trigger")
    for i, m in enumerate(h.get("minions", []) or []):
        v_minion(m, f"{p}.minions[{i}]({m.get('name')})")


def main():
    if not os.path.exists(ROSTER):
        print(f"roster file not found: {ROSTER}")
        sys.exit(2)
    data = json.load(open(ROSTER, encoding="utf-8"))
    heroes = data.get("heroes", data) if isinstance(data, dict) else data
    per_hero = {}
    for h in heroes:
        before = len(errors)
        v_hero(h)
        per_hero[h.get("id", "?")] = len(errors) - before
    print(f"validated {len(heroes)} heroes, {sum(len(h.get('skills', []) or []) for h in heroes)} skills")
    clean = [k for k, n in per_hero.items() if n == 0]
    dirty = {k: n for k, n in per_hero.items() if n}
    print(f"CLEAN heroes ({len(clean)}): {', '.join(clean)}")
    if dirty:
        print(f"heroes WITH errors ({len(dirty)}): {dirty}")
    print(f"\nTOTAL structural errors: {len(errors)}")
    for e in errors[:120]:
        print("  " + e)
    if len(errors) > 120:
        print(f"  ... and {len(errors) - 120} more")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
