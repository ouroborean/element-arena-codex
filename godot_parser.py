"""
godot_parser.py - a small, robust parser for Godot .tscn / .tres text resources.

This does NOT depend on Godot or any game code. It reads the plain-text
".tscn"/".tres" format (an INI-like structure of [sections] with `key = value`
property bodies) and turns it into structured Python data.

The value grammar is parsed with a real recursive-descent reader (not per-field
regex), so it correctly handles:
  - strings ("...", with \\" and \\\\ escapes)
  - ints / floats / bools / null
  - multi-line dictionaries  { "A": true, "B": 1, }   (trailing commas ok)
  - arrays                    [ 1, 2, 3 ]
  - ExtResource("id") / SubResource("id") references
  - constructor calls         Color(1,0,0,1)  Vector2(3,4)  (kept structurally)

Public API:
  parse_file(path)  -> GodotResource
  GodotResource.main_properties()          properties of the [node]/[resource]
  GodotResource.resolve(value)             turn a ref dict into its ext_resource path
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# --------------------------------------------------------------------------- #
#  Section header parsing
# --------------------------------------------------------------------------- #

_HEADER_RE = re.compile(r"^\[(?P<type>[A-Za-z_]+)(?P<attrs>.*)\]\s*$")


def _parse_header_attrs(attrs: str) -> dict[str, Any]:
    """Parse `key="v" key=v` attribute soup from a section header line."""
    out: dict[str, Any] = {}
    for m in re.finditer(r'(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s]+)', attrs):
        key, raw = m.group(1), m.group(2)
        out[key] = _scalar(raw)
    return out


def _scalar(raw: str) -> Any:
    """Cheap scalar coercion for header attribute values."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        return _unescape(raw[1:-1])
    if raw in ("true", "false"):
        return raw == "true"
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d*(?:e-?\d+)?", raw):
        return float(raw)
    return raw


def _unescape(s: str) -> str:
    """Resolve backslash escapes without touching non-ASCII/UTF-8 bytes."""
    if "\\" not in s:
        return s
    out: list[str] = []
    i = 0
    mapping = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append(mapping.get(nxt, nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


# --------------------------------------------------------------------------- #
#  Value parser (recursive descent over the RHS of `key = value`)
# --------------------------------------------------------------------------- #

# Sentinel dict shapes we emit for Godot-specific constructs:
#   {"__ref__": "ExtResource", "id": "1_abc"}
#   {"__ref__": "SubResource", "id": "2_def"}
#   {"__ctor__": "Color", "args": [1, 0, 0, 1]}

class _ValueReader:
    def __init__(self, text: str):
        self.s = text
        self.i = 0
        self.n = len(text)

    def parse(self) -> Any:
        self._ws()
        val = self._value()
        self._ws()
        return val

    def _ws(self) -> None:
        while self.i < self.n and self.s[self.i] in " \t\r\n":
            self.i += 1

    def _peek(self) -> str:
        return self.s[self.i] if self.i < self.n else ""

    def _value(self) -> Any:
        self._ws()
        c = self._peek()
        if c == '"':
            return self._string()
        if c == "{":
            return self._dict()
        if c == "[":
            return self._array()
        if c == "" :
            return None
        # identifier: keyword, number, ref, or constructor
        return self._word_or_call()

    def _string(self) -> str:
        assert self.s[self.i] == '"'
        self.i += 1
        buf = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\":
                nxt = self.s[self.i + 1] if self.i + 1 < self.n else ""
                mapping = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}
                buf.append(mapping.get(nxt, nxt))
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                return "".join(buf)
            buf.append(c)
            self.i += 1
        return "".join(buf)  # unterminated; return what we have

    def _dict(self) -> dict:
        assert self.s[self.i] == "{"
        self.i += 1
        out: dict = {}
        while True:
            self._ws()
            c = self._peek()
            if c == "}":
                self.i += 1
                return out
            if c == "":
                return out
            if c == ",":
                self.i += 1
                continue
            key = self._value()
            self._ws()
            if self._peek() == ":":
                self.i += 1
            val = self._value()
            out[key if isinstance(key, (str, int, float, bool)) else str(key)] = val

    def _array(self) -> list:
        assert self.s[self.i] == "["
        self.i += 1
        out: list = []
        while True:
            self._ws()
            c = self._peek()
            if c == "]":
                self.i += 1
                return out
            if c == "":
                return out
            if c == ",":
                self.i += 1
                continue
            out.append(self._value())

    def _word_or_call(self) -> Any:
        start = self.i
        while self.i < self.n and self.s[self.i] not in ",{}[]:()\"":
            self.i += 1
        word = self.s[start:self.i].strip()
        # Constructor / ref call?
        if self._peek() == "(":
            args = self._call_args()
            if word in ("ExtResource", "SubResource"):
                rid = args[0] if args else None
                return {"__ref__": word, "id": rid}
            return {"__ctor__": word, "args": args}
        return self._keyword_or_number(word)

    def _call_args(self) -> list:
        assert self.s[self.i] == "("
        self.i += 1
        out: list = []
        while True:
            self._ws()
            c = self._peek()
            if c == ")":
                self.i += 1
                return out
            if c == "":
                return out
            if c == ",":
                self.i += 1
                continue
            out.append(self._value())

    @staticmethod
    def _keyword_or_number(word: str) -> Any:
        if word == "true":
            return True
        if word == "false":
            return False
        if word in ("null", "None", ""):
            return None
        if re.fullmatch(r"-?\d+", word):
            return int(word)
        if re.fullmatch(r"-?\d+\.\d*(?:e-?\d+)?", word, re.IGNORECASE):
            return float(word)
        if re.fullmatch(r"-?\d*\.\d+(?:e-?\d+)?", word, re.IGNORECASE):
            return float(word)
        return word  # bare identifier / enum token


def parse_value(text: str) -> Any:
    return _ValueReader(text).parse()


# --------------------------------------------------------------------------- #
#  File-level structure
# --------------------------------------------------------------------------- #

@dataclass
class GodotSection:
    kind: str                      # "gd_scene", "ext_resource", "node", "resource", ...
    attrs: dict[str, Any]          # header attributes
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class GodotResource:
    path: Path
    sections: list[GodotSection]
    ext_resources: dict[str, GodotSection]   # id -> ext_resource section

    # -- convenience ------------------------------------------------------- #
    def _first(self, *kinds: str) -> GodotSection | None:
        for s in self.sections:
            if s.kind in kinds:
                return s
        return None

    def main_section(self) -> GodotSection | None:
        """The primary data node: [node] for scenes, [resource] for .tres."""
        return self._first("node", "resource")

    def main_properties(self) -> dict[str, Any]:
        sec = self.main_section()
        return sec.properties if sec else {}

    def resolve(self, value: Any) -> Any:
        """Resolve an ExtResource ref dict to its `path` (else return as-is)."""
        if isinstance(value, dict) and value.get("__ref__") == "ExtResource":
            ext = self.ext_resources.get(value.get("id"))
            if ext:
                return ext.attrs.get("path")
        return value

    def resolved_properties(self) -> dict[str, Any]:
        """main_properties() with any ExtResource refs replaced by their paths."""
        return {k: self.resolve(v) for k, v in self.main_properties().items()}


# --------------------------------------------------------------------------- #
#  Multi-line value accumulation (quote-aware bracket balancing)
# --------------------------------------------------------------------------- #

def _brackets_balanced(text: str) -> bool:
    depth = 0
    in_str = False
    esc = False
    for c in text:
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "{[(":
            depth += 1
        elif c in "}])":
            depth -= 1
    return depth <= 0 and not in_str


def parse_text(text: str, path: Path | None = None) -> GodotResource:
    lines = text.splitlines()
    sections: list[GodotSection] = []
    current: GodotSection | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        header = _HEADER_RE.match(line)
        if header:
            current = GodotSection(
                kind=header.group("type"),
                attrs=_parse_header_attrs(header.group("attrs")),
            )
            sections.append(current)
            i += 1
            continue

        # property line inside the current section
        if current is not None and "=" in line:
            key, _, rhs = line.partition("=")
            key = key.strip()
            rhs = rhs.strip()
            # accumulate continuation lines for multi-line structures
            if rhs and rhs[0] in "{[(" and not _brackets_balanced(rhs):
                buf = [rhs]
                i += 1
                while i < len(lines) and not _brackets_balanced("\n".join(buf)):
                    buf.append(lines[i])
                    i += 1
                rhs = "\n".join(buf)
            else:
                i += 1
            if key:
                current.properties[key] = parse_value(rhs)
            continue

        i += 1

    ext = {
        s.attrs.get("id"): s
        for s in sections
        if s.kind == "ext_resource" and "id" in s.attrs
    }
    return GodotResource(path=path or Path("<memory>"), sections=sections, ext_resources=ext)


def parse_file(path: str | Path) -> GodotResource:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    return parse_text(text, p)


if __name__ == "__main__":
    import json
    import sys

    res = parse_file(sys.argv[1])
    print(json.dumps(res.resolved_properties(), indent=2, ensure_ascii=False))
