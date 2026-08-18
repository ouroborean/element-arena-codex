# Decision log

Durable record of the choices that shape everything downstream. Newest first.

---

## D1 — Oracle: faithful reconstruction of the original game

**Decided.** The rebuild aims to **match the original game's behaviour**, not to be a
new game inspired by it. Authored effect logic is correct insofar as it reproduces
what the original did.

**Consequences**
- The authoritative specification for a skill is, in priority order:
  1. the original **GDScript `execute()` body** for that skill (ground truth),
  2. the original **designer's** ruling where code is ambiguous,
  3. the skill's prose **description** (what the export gives us),
  4. a **`RULINGS.md` default** — provisional, used only to unblock engine work.
- Every golden fixture asserts *what the original did*. Where (1) is unavailable,
  the fixture is marked `oracle: description|ruling|default` so its confidence is
  explicit and re-checkable when the source arrives.
- The `designer_question: true` rulings are now a **real blocking dependency** for
  final content — but **not** for engine scaffolding, which proceeds on the
  provisional defaults and is re-validated when answers land.

**The high-leverage implication:** the GDScript was never lost — it was simply not
part of this data export. Obtaining the original Godot project (at least
`components/`, `skills/`, `augments/`) turns ~1-in-5 invented numbers into
transcription against ground truth and resolves most open rulings from code. This
is the single biggest risk reducer available and should be pursued before volume
authoring begins. See `SOURCE_ACCESS.md`.

---

## D0 — Scaffold inside the codex repo (provisional)

**Decided (reversible).** The game is being built in `game/` inside the codex repo,
reading `output/` as source and writing its own frozen `content/`. It is
self-contained so it can be lifted into a separate repository at P1 without
touching the codex's 132 MB git history. Revisit at the P1 monorepo decision.
