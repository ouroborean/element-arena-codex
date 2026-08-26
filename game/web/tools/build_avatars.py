#!/usr/bin/env python3
"""
Regenerate assets/avatars/manifest.json from the image files in assets/avatars/.

The player-profile panel's avatar picker reads this manifest at runtime, so after dropping new avatar
images into assets/avatars/ (png / jpg / jpeg / webp / gif / svg), run:

    python game/web/tools/build_avatars.py

Each entry is {"file": "<filename>", "name": "<Title Case stem>"}, sorted by name.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
AVATAR_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "assets", "avatars"))
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
SKIP_STEMS = {"empty"}  # blank/utility placeholders, not selectable avatars


def main():
    files = sorted(
        f for f in os.listdir(AVATAR_DIR)
        if os.path.splitext(f)[1].lower() in EXTS
        and os.path.splitext(f)[0].lower() not in SKIP_STEMS
    )
    manifest = [
        {"file": f, "name": os.path.splitext(f)[0].replace("_", " ").replace("-", " ").title()}
        for f in files
    ]
    out = os.path.join(AVATAR_DIR, "manifest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {out}: {len(manifest)} avatars")


if __name__ == "__main__":
    main()
