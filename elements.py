"""
elements.py - extract the elemental system from components/types/element.gd.

Produces:
  * the Element.Type enum          (id -> name)
  * base-element panel colors      (hex, from get_major_panel_color)
  * the fusion recipe table        base_a x base_b -> fusion result
  * per-fusion component pairs      fusion -> [ (base_a, base_b), ... ]

All parsing is text-based off element.gd; no Godot runtime involved.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

BASE_COUNT = 10  # FIRE..SHADOW are the 10 base elements


def _pretty(name: str) -> str:
    """FIRE -> Fire, ALL_FACTION -> All Faction (Godot-ish capitalize)."""
    return name.replace("_", " ").title()


def parse_enum(gd_text: str) -> list[str]:
    m = re.search(r"enum\s+Type\s*\{(.*?)\}", gd_text, re.DOTALL)
    if not m:
        raise ValueError("Element.Type enum not found in element.gd")
    body = m.group(1)
    names: list[str] = []
    for raw in body.split(","):
        # strip inline comments and whitespace
        token = raw.split("#")[0].strip()
        if token:
            names.append(token)
    return names


def parse_base_colors(gd_text: str) -> dict[int, str]:
    """Pull `N: return Color.hex(0xRRGGBBAA)` pairs from get_major_panel_color."""
    m = re.search(
        r"static func get_major_panel_color\(element\):(.*?)(?:\n\s*static func|\Z)",
        gd_text,
        re.DOTALL,
    )
    block = m.group(1) if m else gd_text
    colors: dict[int, str] = {}
    for cm in re.finditer(r"(\d+):\s*\n\s*return Color\.hex\(0x([0-9a-fA-F]{8})\)", block):
        idx = int(cm.group(1))
        rgba = cm.group(2).lower()
        # store as #RRGGBB plus alpha kept separately
        colors[idx] = "#" + rgba[:6]
    return colors


def parse_hybrids(gd_text: str) -> dict[tuple[str, str], str]:
    """Parse the hybrids() table into (base_a_name, base_b_name) -> fusion_name."""
    m = re.search(
        r"static func hybrids\(\):(.*?)return hybrids", gd_text, re.DOTALL
    )
    if not m:
        raise ValueError("hybrids() not found in element.gd")
    body = m.group(1)

    recipes: dict[tuple[str, str], str] = {}
    current_outer: str | None = None
    outer_re = re.compile(r"Element\.Type\.(\w+):\s*\{")
    inner_re = re.compile(r"Element\.Type\.(\w+):\s*Element\.Type\.(\w+)")
    for line in body.splitlines():
        om = outer_re.search(line)
        if om and line.rstrip().endswith("{"):
            current_outer = om.group(1)
            continue
        im = inner_re.search(line)
        if im and current_outer:
            recipes[(current_outer, im.group(1))] = im.group(2)
    return recipes


def build(gd_path: str | Path) -> dict[str, Any]:
    gd_text = Path(gd_path).read_text(encoding="utf-8")
    names = parse_enum(gd_text)
    name_to_id = {n: i for i, n in enumerate(names)}
    base_colors = parse_base_colors(gd_text)
    recipes = parse_hybrids(gd_text)  # (nameA, nameB) -> nameResult

    # fusion -> set of component pairs (as base ids, sorted within a pair)
    components: dict[str, set[tuple[int, int]]] = {}
    for (a, b), result in recipes.items():
        pair = tuple(sorted((name_to_id[a], name_to_id[b])))
        components.setdefault(result, set()).add(pair)

    elements: list[dict[str, Any]] = []
    for idx, name in enumerate(names):
        is_generic = name == "GENERIC"
        is_base = idx < BASE_COUNT and not is_generic
        entry: dict[str, Any] = {
            "id": idx,
            "name": name.lower(),
            "enum": name,
            "display_name": _pretty(name),
            "is_base": is_base,
            "is_fusion": (not is_base) and not is_generic,
            "is_generic": is_generic,
        }
        if is_base and idx in base_colors:
            entry["color"] = base_colors[idx]
        if name in components:
            entry["components"] = [
                {"a": a, "b": b, "a_name": names[a].lower(), "b_name": names[b].lower()}
                for (a, b) in sorted(components[name])
            ]
        elements.append(entry)

    # fusion matrix as a flat list of recipes (deduped, a <= b)
    recipe_list: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for (a, b), result in recipes.items():
        ai, bi = sorted((name_to_id[a], name_to_id[b]))
        key = (ai, bi)
        if key in seen:
            continue
        seen.add(key)
        recipe_list.append(
            {
                "a": ai,
                "b": bi,
                "a_name": names[ai].lower(),
                "b_name": names[bi].lower(),
                "result": name_to_id[result],
                "result_name": result.lower(),
            }
        )
    recipe_list.sort(key=lambda r: (r["a"], r["b"]))

    return {
        "elements": elements,
        "fusion_recipes": recipe_list,
        "_name_to_id": name_to_id,   # helper for other extractors (stripped from output)
        "_names": names,
    }


if __name__ == "__main__":
    import json

    root = Path(__file__).resolve().parent.parent
    data = build(root / "components" / "types" / "element.gd")
    data.pop("_name_to_id", None)
    data.pop("_names", None)
    print(json.dumps(data, indent=2, ensure_ascii=False))
