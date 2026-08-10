"""
metadata.py - pull roster-level metadata out of character_database.gd.

These are GDScript static functions returning array / dictionary literals
(roster, bot list, fusion/augment exclusions, and the title word-banks used to
generate flavour names). We read the literals textually - commented-out entries
(lines beginning with '#') are correctly ignored.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def _func_body(gd_text: str, func_name: str) -> str:
    m = re.search(
        rf"static func {re.escape(func_name)}\([^)]*\):(.*?)(?:\n\s*static func |\Z)",
        gd_text,
        re.DOTALL,
    )
    return m.group(1) if m else ""


def _strings_in_array(body: str) -> list[str]:
    """All double-quoted strings on non-comment lines of a `return [...]` body."""
    out: list[str] = []
    for line in body.splitlines():
        code = line.split("#", 1)[0]  # drop trailing/whole-line comments
        out.extend(re.findall(r'"([^"]*)"', code))
    return out


def _dict_of_string_lists(body: str) -> dict[str, list[str]]:
    """Parse `"key": ["a", "b"],` entries (ignoring comment lines)."""
    out: dict[str, list[str]] = {}
    for line in body.splitlines():
        code = line.split("#", 1)[0]
        m = re.match(r'\s*"([^"]+)"\s*:\s*\[(.*)\]', code)
        if m:
            out[m.group(1)] = re.findall(r'"([^"]*)"', m.group(2))
    return out


def _dict_of_strings(body: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in body.splitlines():
        code = line.split("#", 1)[0]
        m = re.match(r'\s*"([^"]+)"\s*:\s*"([^"]*)"', code)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def build(gd_path: str | Path) -> dict[str, Any]:
    text = Path(gd_path).read_text(encoding="utf-8")
    return {
        "roster": _strings_in_array(_func_body(text, "get_char_name_list")),
        "implemented": _strings_in_array(_func_body(text, "implemented_characters")),
        "bot_characters": _strings_in_array(_func_body(text, "bot_characters")),
        "no_fusion_characters": _strings_in_array(_func_body(text, "no_fusion_characters")),
        "no_augment_characters": _strings_in_array(_func_body(text, "no_augment_characters")),
        "short_names": _dict_of_strings(_func_body(text, "character_name_from_path")),
        "minor_titles": _dict_of_string_lists(_func_body(text, "minor_titles")),
        "major_titles": _dict_of_string_lists(_func_body(text, "major_titles")),
        "middle_titles": _dict_of_string_lists(_func_body(text, "middle_titles")),
    }


if __name__ == "__main__":
    import json

    root = Path(__file__).resolve().parent.parent
    print(json.dumps(build(root / "components" / "character" / "character_database.gd"),
                     indent=2, ensure_ascii=False))
