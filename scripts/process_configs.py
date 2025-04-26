#!/usr/bin/env python3
import json, re, shutil, sys
from pathlib import Path
from jsonschema import Draft202012Validator 

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "config.schema.json"      # <- matches your repo
RAW_DIR     = ROOT / "configs"
OUT_DIR     = ROOT / "site"           # artifact root for Pages

schema = json.loads(SCHEMA_PATH.read_text())
validator = Draft202012Validator(schema)

def validate_file(path: Path):
    data = json.loads(path.read_text())
    errors = sorted(validator.iter_errors(data), key=str)
    if errors:
        for e in errors:
            print(f"{path}: {e.message}", file=sys.stderr)
        raise ValueError(f"{path} failed schema validation")
    # extra integrity checks not expressible in pure schema
    if any(abs(n["node_data"]["x"]) +
           abs(n["node_data"]["y"]) +
           abs(n["node_data"]["z"]) == 0 for n in data["nodes"]):
        raise ValueError(f"{path}: node at origin (0,0,0) is not allowed")
    return data

def process():
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    for p in RAW_DIR.rglob("*.json"):
        data = validate_file(p)
        m = data["meta"]
        dest = OUT_DIR / m["map_author"] / m["map_name"] / str(m["map_version"])
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "index.json").write_text(json.dumps(data, indent=2, sort_keys=False))
    # Sort for deterministic output
    for folder in OUT_DIR.rglob("*"):
        if folder.is_dir():
            for child in sorted(folder.iterdir(), key=lambda x: x.name):
                pass  # filesystem order isn’t guaranteed; git handles it
if __name__ == "__main__":
    process()
