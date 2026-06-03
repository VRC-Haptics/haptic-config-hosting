#!/usr/bin/env node
// Walks CONFIG_DIR, migrates every config to the latest schema version using the
// remote migration scripts, validates before and after each step, and writes
// changed files in place. Designed to run inside a GitHub Actions job.

import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const CONFIG_DIR = process.env.CONFIG_DIR || "configs";
const BASE_URL = (process.env.SCHEMA_BASE_URL || "https://vrc-haptics.github.io/mapping-schema").replace(/\/$/, "");
const SCHEMA_BASE = `${BASE_URL}/schema`;

// ---- remote fetch helpers ------------------------------------------------

const textCache = new Map();
async function fetchText(url) {
  if (textCache.has(url)) return textCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  // gh-pages serves a 200 HTML 404 page for missing files; reject that.
  if (ct.includes("text/html") || /^\s*<!DOCTYPE html>/i.test(body)) {
    throw new Error(`GET ${url} -> missing (got HTML 404 page)`);
  }
  textCache.set(url, body);
  return body;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

// ---- schema validation (resolves remote $ref via compileAsync) -----------

const validatorCache = new Map();
async function getValidator(version) {
  if (validatorCache.has(version)) return validatorCache.get(version);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    loadSchema: async (uri) => fetchJson(uri),
  });
  addFormats(ajv);
  const root = await fetchJson(`${SCHEMA_BASE}/${version}/map.schema.json`);
  const validate = await ajv.compileAsync(root);
  validatorCache.set(version, validate);
  return validate;
}

async function validateAgainst(version, doc) {
  const validate = await getValidator(version);
  const ok = validate(doc);
  return ok ? null : ajvErrors(validate.errors);
}

function ajvErrors(errors) {
  return (errors || [])
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

// ---- v0.0.0 shape check (no published schema for deprecated versions) -----

const v000Validate = (() => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile({
    type: "object",
    required: ["nodes", "meta"],
    properties: {
      nodes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["node_data", "address", "is_external_address", "radius", "target_bone"],
          properties: {
            node_data: {
              type: "object",
              required: ["x", "y", "z", "groups"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                z: { type: "number" },
                groups: { type: "array", items: { type: "string" } },
              },
            },
            address: { type: "string" },
            is_external_address: { type: "boolean" },
            radius: { type: "number" },
            target_bone: { type: "string" },
          },
        },
      },
      meta: {
        type: "object",
        required: ["map_name", "map_author", "map_version"],
        properties: {
          map_name: { type: "string" },
          map_author: { type: "string" },
          map_version: { type: "integer" },
        },
      },
    },
  });
})();

function looksLikeV000(doc) {
  return v000Validate(doc) ? null : ajvErrors(v000Validate.errors);
}

// ---- remote migration module loader --------------------------------------

const moduleCache = new Map();
let tmpRoot = null;
let tmpSeq = 0;
async function loadMigration(url) {
  if (moduleCache.has(url)) return moduleCache.get(url);
  let text = await fetchText(url);
  // ${{BASE_URL}} is normally substituted at build time; do it defensively.
  text = text.split("${{BASE_URL}}").join(BASE_URL);
  if (!tmpRoot) tmpRoot = await mkdtemp(join(tmpdir(), "mig-"));
  const file = join(tmpRoot, `m${tmpSeq++}.mjs`);
  await writeFile(file, text);
  const mod = (await import(pathToFileURL(file).href)).default;
  if (!mod || typeof mod.migrate !== "function" || typeof mod.gather !== "function") {
    throw new Error(`module at ${url} is not a valid Migration`);
  }
  moduleCache.set(url, mod);
  return mod;
}

function makeCtx(label) {
  const store = new Map();
  return {
    log: (m) => console.log(`      [${label}] ${m}`),
    warn: (m) => console.log(`      [${label}] WARN ${m}`),
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    request: (prompt, def, key) => {
      // Non-interactive: record the default (null if none) and continue.
      const val = def === undefined ? null : def;
      store.set(key, val);
      console.log(`      [${label}] request("${prompt}") -> default ${JSON.stringify(val)}`);
      return val;
    },
  };
}

// Runs one migration module against `doc`, returns the migrated doc.
async function runMigration(mod, doc) {
  const ctx = makeCtx(`${mod.from}->${mod.to}`);
  await mod.gather(doc, ctx);
  return await mod.migrate(doc, ctx);
}

// ---- per-file processing --------------------------------------------------

const SKIP = Symbol("skip"); // requires user input

// Migrate `doc` (already at `fromVersion`) up the supported chain to latest.
// Validates after every step. Throws on failure. Returns final doc.
async function migrateUp(doc, fromVersion, supported, file, notes) {
  let current = doc;
  let idx = supported.indexOf(fromVersion);
  if (idx === -1) throw new Error(`version ${fromVersion} not in schemaVersions`);
  while (idx < supported.length - 1) {
    const from = supported[idx];
    const url = `${SCHEMA_BASE}/${from}/up.js`;
    const mod = await loadMigration(url);
    if (mod.requiresUserInput) {
      notes.push(`stops at ${from}: ${from}->${mod.to} requires user input`);
      return SKIP;
    }
    try {
      current = await runMigration(mod, current);
    } catch (e) {
      throw new Error(`migration ${from}->${mod.to} threw: ${e.message}`);
    }
    const verr = await validateAgainst(mod.to, current);
    if (verr) throw new Error(`post-migration validation failed at ${mod.to}: ${verr}`);
    notes.push(`migrated ${from}->${mod.to}`);
    idx = supported.indexOf(mod.to);
    if (idx === -1) throw new Error(`migration target ${mod.to} not in schemaVersions`);
  }
  return current;
}

async function processFile(file, versions) {
  const supported = versions.schemaVersions;
  const deprecated = versions.deprecatedVersions;
  const latest = supported[supported.length - 1];
  const notes = [];

  const raw = await readFile(file, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { file, status: "failed", reason: `invalid JSON: ${e.message}`, notes };
  }

  let working = doc;

  // ---- determine version + run any deprecated bridge -----------------------
  const declared = typeof doc.schemaVersion === "string" ? doc.schemaVersion : null;

  if (declared && supported.includes(declared)) {
    // standard validation against its own claimed version
    const verr = await validateAgainst(declared, doc);
    if (verr) return { file, status: "failed", reason: `fails ${declared} schema: ${verr}`, notes };
    working = doc;
    working.__from = declared;
  } else if ((declared && deprecated.includes(declared)) || (!declared && deprecated.includes("v0.0.0"))) {
    const dv = declared || "v0.0.0";
    if (dv === "v0.0.0") {
      const serr = looksLikeV000(doc);
      if (serr) return { file, status: "failed", reason: `not a valid v0.0.0 document: ${serr}`, notes };
    }
    const mod = await loadMigration(`${SCHEMA_BASE}/deprecated/${dv}.js`);
    if (mod.requiresUserInput) {
      return { file, status: "skipped", reason: `deprecated ${dv}->${mod.to} requires user input`, notes };
    }
    try {
      working = await runMigration(mod, doc);
    } catch (e) {
      return { file, status: "failed", reason: `deprecated migration ${dv}->${mod.to} threw: ${e.message}`, notes };
    }
    const verr = await validateAgainst(mod.to, working);
    if (verr) return { file, status: "failed", reason: `post-migration validation failed at ${mod.to}: ${verr}`, notes };
    notes.push(`deprecated ${dv}->${mod.to}`);
    working.__from = mod.to;
  } else {
    return {
      file,
      status: "failed",
      reason: declared ? `unknown schemaVersion "${declared}"` : "no schemaVersion and not a recognized deprecated shape",
      notes,
    };
  }

  // ---- climb supported chain to latest -------------------------------------
  const from = working.__from;
  delete working.__from;
  let result;
  try {
    result = await migrateUp(working, from, supported, file, notes);
  } catch (e) {
    return { file, status: "failed", reason: e.message, notes };
  }
  if (result === SKIP) return { file, status: "skipped", reason: notes[notes.length - 1], notes };

  // final guard: must validate against latest
  const finalErr = await validateAgainst(latest, result);
  if (finalErr) return { file, status: "failed", reason: `final ${latest} validation failed: ${finalErr}`, notes };

  const next = JSON.stringify(result, null, 4) + "\n";
  if (next === raw) return { file, status: "unchanged", reason: `already ${latest}`, notes };
  await writeFile(file, next);
  return { file, status: "changed", reason: `now ${latest}`, notes };
}

// Recursively collect all file paths under `dir` (Node 18+ compatible).
async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const versions = await fetchJson(`${SCHEMA_BASE}/versions.json`);
  if (!Array.isArray(versions.schemaVersions) || versions.schemaVersions.length === 0) {
    throw new Error("versions.json has no schemaVersions");
  }
  versions.deprecatedVersions = versions.deprecatedVersions || [];
  console.log(`Latest version: ${versions.schemaVersions[versions.schemaVersions.length - 1]}`);

  const files = (await walk(CONFIG_DIR)).filter((f) => f.endsWith(".json")).sort();
  console.log(`Found ${files.length} config file(s) under ${CONFIG_DIR}\n`);

  const results = [];
  for (const file of files) {
    console.log(`-> ${file}`);
    let r;
    try {
      r = await processFile(file, versions);
    } catch (e) {
      r = { file, status: "failed", reason: `unexpected error: ${e.message}`, notes: [] };
    }
    for (const n of r.notes) console.log(`      ${n}`);
    console.log(`   [${r.status}] ${r.reason}`);
    results.push(r);
  }

  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });

  const by = (s) => results.filter((r) => r.status === s);
  const changed = by("changed");
  const failed = by("failed");
  const skipped = by("skipped");
  const unchanged = by("unchanged");

  // step summary
  const sum = [
    `### Config migration`,
    ``,
    `Latest schema version: \`${versions.schemaVersions.at(-1)}\``,
    ``,
    `| File | Status | Detail |`,
    `| --- | --- | --- |`,
    ...results.map((r) => `| \`${r.file}\` | ${r.status} | ${r.reason.replace(/\|/g, "\\|")} |`),
    ``,
    `**${changed.length} changed, ${unchanged.length} unchanged, ${skipped.length} skipped, ${failed.length} failed**`,
  ].join("\n");
  console.log("\n" + sum);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, sum + "\n", { flag: "a" });
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `changed=${changed.length > 0}\nfailures=${failed.length}\nskipped=${skipped.length}\n`,
      { flag: "a" }
    );
  }
  // Always exit 0 so the PR step can run; the workflow fails the job afterward.
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
