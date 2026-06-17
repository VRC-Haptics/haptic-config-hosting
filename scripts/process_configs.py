#!/usr/bin/env python3
"""Validate every map against the schema it declares, run extra integrity checks
the schema can't express, then stage valid maps under <author>/<name>/<version>/
with a catalog.json. Exits non-zero (failing the workflow, so nothing deploys) if
any map is invalid."""

import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
import zipfile

BASE_URL = os.environ.get("SCHEMA_BASE_URL", "https://vrc-haptics.github.io/mapping-schema").rstrip("/")
SCHEMA_BASE = f"{BASE_URL}/schema"
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "configs"))
OUT_DIR = Path(os.environ.get("SITE_DIR", "site"))

_text_cache: dict[str, str] = {}


def fetch_text(url: str) -> str:
    if url in _text_cache:
        return _text_cache[url]
    req = urllib.request.Request(url, headers={"User-Agent": "map-validator"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode("utf-8")
    if body.lstrip().startswith("<!DOCTYPE html>"):
        raise FileNotFoundError(f"{url} -> not found (HTML 404 page)")
    _text_cache[url] = body
    return body


def fetch_json(url: str) -> dict:
    return json.loads(fetch_text(url))


def _retrieve(uri: str) -> Resource:
    base, ref = urlsplit(SCHEMA_BASE), urlsplit(uri)
    same_origin = (
        base.scheme.lower() == ref.scheme.lower()
        and base.netloc.lower() == ref.netloc.lower()
    )
    if not (same_origin and ref.path.startswith(base.path + "/")):
        raise ValueError(f"refusing to fetch schema ref outside {SCHEMA_BASE}: {uri}")
    return Resource.from_contents(fetch_json(uri))


REGISTRY = Registry(retrieve=_retrieve)

_validator_cache: dict[str, Draft202012Validator] = {}


def validator_for(schema_url: str) -> Draft202012Validator:
    if schema_url not in _validator_cache:
        schema = fetch_json(schema_url)
        Draft202012Validator.check_schema(schema)
        _validator_cache[schema_url] = Draft202012Validator(schema, registry=REGISTRY)
    return _validator_cache[schema_url]


def schema_url_for(doc: dict, supported: list[str]) -> str:
    version = doc.get("schemaVersion")
    if not isinstance(version, str):
        raise ValueError("map has no schemaVersion")
    if version not in supported:
        raise ValueError(f'schemaVersion "{version}" is not a supported version {supported}')
    return f"{SCHEMA_BASE}/{version}/map.schema.json"


def integrity_errors(doc: dict) -> list[str]:
    errs = []
    for i, n in enumerate(doc.get("nodes", [])):
        loc = n.get("location")
        if isinstance(loc, list) and len(loc) == 3 and sum(abs(c) for c in loc) == 0:
            errs.append(f"/nodes/{i}/location: node at origin (0,0,0) is not allowed")
    return errs


def validate_file(path: Path, supported: list[str]) -> list[str]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"invalid JSON: {e}"]
    try:
        url = schema_url_for(doc, supported)
    except ValueError as e:
        return [str(e)]
    try:
        validator = validator_for(url)
    except Exception as e:
        return [f"could not load schema {url}: {e}"]

    errs = [
        f"{'/' + '/'.join(map(str, e.absolute_path)) if e.absolute_path else '<root>'}: {e.message}"
        for e in sorted(validator.iter_errors(doc), key=lambda x: list(x.absolute_path))
    ]
    errs += integrity_errors(doc)
    return errs


def main() -> int:
    supported = fetch_json(f"{SCHEMA_BASE}/versions.json").get("schemaVersions", [])
    if not supported:
        print("::error::versions.json has no schemaVersions", flush=True)
        return 1
    print(f"Supported versions: {supported}")

    files = sorted(CONFIG_DIR.rglob("*.json"))
    print(f"Validating {len(files)} map(s) under {CONFIG_DIR}\n")

    valid: list[tuple[Path, dict]] = []
    failures = 0
    for path in files:
        errs = validate_file(path, supported)
        if errs:
            failures += 1
            print(f"FAIL {path}")
            for e in errs:
                print(f"     - {e}")
            print(f"::error file={path}::map failed validation ({len(errs)} error(s))")
        else:
            valid.append((path, json.loads(path.read_text(encoding="utf-8"))))
            print(f"OK   {path}")

    if failures:
        print(f"\n{failures} map(s) failed validation; not publishing.", flush=True)
        return 1

    shutil.rmtree(OUT_DIR, ignore_errors=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    catalog = []
    for path, doc in valid:
        ident = doc["identification"]
        author, name, version = ident["authorName"], ident["mapName"], int(ident["mapVersion"])
        dest = OUT_DIR / author / name / str(version)
        dest.mkdir(parents=True, exist_ok=True)
        arcname = f"{author}/{name}/{version}/index.json.zip"
        payload = json.dumps(doc, indent=2) + "\n"
        with zipfile.ZipFile(OUT_DIR / arcname, "w", compression=zipfile.ZIP_LZMA) as zf:
            zf.writestr("index.json", payload)
        catalog.append(
            {
                "author": author,
                "name": name,
                "version": version,
                "schemaVersion": doc.get("schemaVersion"),
                "url": arcname,
            }
        )

    catalog.sort(key=lambda m: (m["author"], m["name"], m["version"]))
    (OUT_DIR / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")

    print(f"\nPublished {len(valid)} map(s) to {OUT_DIR}/ with catalog.json")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### Map validation\n\nValidated and published **{len(valid)}** map(s).\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())