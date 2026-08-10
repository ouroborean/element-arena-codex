"""
copy_assets.py - copy the character / skill / minion art out of the Godot
project into data_export/, leaving every Godot `.import` sidecar behind.

The source tree `assets/characters/` holds all of it: character portraits and
profile icons, per-skill ability icons (base + fusion forms), and minion art.
Each real image is shadowed by a `<name>.png.import` file that only Godot's
importer cares about - those are skipped.

The directory structure is preserved, so the `image` paths already in the JSON
database (e.g. "assets/characters/gaia/gaia2.png") resolve as-is when the web
app is rooted at data_export/.

Run:   python data_export/copy_assets.py            # copy all char/skill art
       python data_export/copy_assets.py --referenced-only   # only DB-referenced

Writes data_export/assets/characters/... and data_export/output/asset_manifest.json.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "characters"
DEST_ROOT = Path(__file__).resolve().parent / "assets"
DEST = DEST_ROOT / "characters"
OUT = Path(__file__).resolve().parent / "output"
DB = OUT / "database.json"

# Godot importer sidecars / caches we never want to copy.
SKIP_SUFFIXES = {".import"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg"}


def should_copy(src: Path, dst: Path) -> bool:
    """Copy if missing or the source differs in size/mtime (idempotent re-runs)."""
    if not dst.exists():
        return True
    s, d = src.stat(), dst.stat()
    return s.st_size != d.st_size or int(s.st_mtime) > int(d.st_mtime)


def db_image_refs() -> dict[str, list[dict]]:
    """Map image path -> [ {type, id, name}, ... ] from the database."""
    refs: dict[str, list[dict]] = {}
    if not DB.exists():
        print("! database.json not found - run extract_database.py first; "
              "copying without cross-validation.")
        return refs
    db = json.loads(DB.read_text(encoding="utf-8"))
    for coll in ("characters", "skills", "minions"):
        for r in db.get(coll, []):
            img = r.get("image")
            if img:
                refs.setdefault(img, []).append(
                    {"type": coll[:-1], "id": r["id"], "name": r.get("name") or r.get("character_name")}
                )
    return refs


def main() -> None:
    referenced_only = "--referenced-only" in sys.argv
    if not SRC.is_dir():
        sys.exit(f"source asset dir not found: {SRC}")

    refs = db_image_refs()
    referenced_rel = set(refs.keys())  # e.g. "assets/characters/gaia/gaia2.png"

    copied = skipped_import = skipped_unreferenced = up_to_date = 0
    non_image: list[str] = []
    copied_rel: set[str] = set()

    for src in sorted(SRC.rglob("*")):
        if src.is_dir():
            continue
        if src.suffix in SKIP_SUFFIXES:
            skipped_import += 1
            continue
        rel = src.relative_to(ROOT).as_posix()          # assets/characters/.../x.png
        if src.suffix.lower() not in IMAGE_SUFFIXES:
            non_image.append(rel)
            continue
        if referenced_only and rel not in referenced_rel:
            skipped_unreferenced += 1
            continue

        dst = DEST_ROOT / src.relative_to(ROOT / "assets")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if should_copy(src, dst):
            shutil.copy2(src, dst)
            copied += 1
        else:
            up_to_date += 1
        copied_rel.add(rel)

    # --- cross-validation against the database --------------------------------
    missing = sorted(referenced_rel - copied_rel)          # DB refs with no file
    unreferenced = sorted(copied_rel - referenced_rel)     # files no DB record uses

    manifest = {
        "_meta": {
            "generator": "data_export/copy_assets.py",
            "source": str(SRC.relative_to(ROOT)).replace("\\", "/"),
            "dest": str(DEST.relative_to(Path(__file__).resolve().parent)).replace("\\", "/"),
            "mode": "referenced-only" if referenced_only else "all",
            "counts": {
                "copied": copied,
                "already_up_to_date": up_to_date,
                "import_sidecars_skipped": skipped_import,
                "unreferenced_skipped": skipped_unreferenced,
                "images_total": len(copied_rel),
                "db_image_refs": len(referenced_rel),
                "db_refs_missing_file": len(missing),
                "images_not_referenced_by_db": len(unreferenced),
            },
        },
        # image path -> which DB records use it
        "by_image": {img: refs.get(img, []) for img in sorted(copied_rel)},
        "db_refs_missing_file": missing,
        "images_not_referenced_by_db": unreferenced,
        "non_image_files_left_in_place": non_image,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "asset_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Assets -> {DEST}")
    for k, v in manifest["_meta"]["counts"].items():
        print(f"  {k:28} {v}")
    if missing:
        print(f"\n  !! {len(missing)} database image refs have NO matching file:")
        for m in missing[:20]:
            print("     -", m)
    else:
        print("\n  OK: every database image reference has a copied file.")
    print(f"\n  manifest -> {OUT / 'asset_manifest.json'}")


if __name__ == "__main__":
    main()
