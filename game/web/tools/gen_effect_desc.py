"""Generate effectdesc.generated.ts from the authored effect_descriptions.json.

effect_descriptions.json is the committed, hand-editable source of truth: a per-effect
STATE description (what holding a mark/stack does) — authored to describe the EFFECT itself,
never the action of the skill that applies it. This emits:
  - EFFECT_DESC: effect name -> description (marks/stacks)
  - EFFECT_HIDE: names that are internal bookkeeping and should not render a chip
Run from repo root: python game/web/tools/gen_effect_desc.py
"""
import json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
src = json.load(open(os.path.join(ROOT, "game/web/tools/effect_descriptions.json"), encoding="utf-8"))

desc = {n: v["description"].strip() for n, v in sorted(src.items()) if v.get("description")}
hide = sorted(n for n, v in src.items() if v.get("hide"))
# A variant = alternate text shown only while the bearer holds a gating status (e.g. Saya's "Enhanced").
variants = {n: v["variant"] for n, v in sorted(src.items()) if isinstance(v.get("variant"), dict) and v["variant"].get("when") and v["variant"].get("text")}

lines = [
    "/**",
    " * Per-effect STATE descriptions for named marks/stacks — what HOLDING the effect does RIGHT NOW,",
    " * describing the effect itself (never the applying skill's action, a fusion form, or a synergy).",
    " * Text may contain {generic}/{fire}/… energy tokens, rendered as icons. A variant overrides the base",
    " * while the bearer holds its `when` status. Authored in effect_descriptions.json; regenerate with",
    " * gen_effect_desc.py. EFFECT_HIDE = internal bookkeeping flags that show no chip.",
    " */",
    "export const EFFECT_DESC: Record<string, string> = {",
]
for n in sorted(desc):
    lines.append(f"  {json.dumps(n)}: {json.dumps(desc[n])},")
lines.append("};")
lines.append("")
lines.append("export interface EffectVariant { when: string; text: string; }")
lines.append("export const EFFECT_VARIANT: Record<string, EffectVariant> = {")
for n in sorted(variants):
    v = variants[n]
    lines.append(f"  {json.dumps(n)}: {{ when: {json.dumps(v['when'])}, text: {json.dumps(v['text'])} }},")
lines.append("};")
lines.append("")
lines.append("export const EFFECT_HIDE: ReadonlySet<string> = new Set([")
for n in hide:
    lines.append(f"  {json.dumps(n)},")
lines.append("]);")

out = os.path.join(ROOT, "game/web/src/effectdesc.generated.ts")
open(out, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
print(f"wrote {out}: {len(desc)} descriptions, {len(variants)} variants, {len(hide)} hidden")
