import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  MAX_VOCABULARY_CHARACTERS,
  MAX_VOCABULARY_TERMS,
  mergeVocabulary,
  readDictationVocabulary,
  readProjectVocabulary,
} from "../src/vocabulary.js";

async function project(t: TestContext): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-vocabulary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  return { root, path: join(root, ".pi", "voice-vocabulary.json") };
}

test("a missing vocabulary or an empty list leaves transcription unconditioned", async (t) => {
  const { root, path } = await project(t);
  assert.deepEqual(await readProjectVocabulary(root), { terms: [] });
  await writeFile(path, '{"terms":[]}');
  assert.deepEqual(await readProjectVocabulary(root), { terms: [] });
});

test("BOM, surrounding whitespace and duplicates are normalized without changing spelling", async (t) => {
  const { root, path } = await project(t);
  await writeFile(path, '\uFEFF' + JSON.stringify({
    terms: [" Meilisearch ", "", "  ", "Dolt", "Meilisearch", "dolt", "测试"],
  }));
  assert.deepEqual(await readProjectVocabulary(root), {
    terms: ["Meilisearch", "Dolt", "dolt", "测试"],
  });
});

test("invalid files return a warning and never partially accept terms", async (t) => {
  const { root, path } = await project(t);
  for (const source of ['{', 'null', '[]', '{}', '{"terms":"Dolt"}', '{"terms":["Dolt",42]}']) {
    await writeFile(path, source);
    const result = await readProjectVocabulary(root);
    assert.deepEqual(result.terms, []);
    assert.match(result.warning!, /Ignoring vocabulary/);
  }
});

test("unreadable vocabulary returns a warning", async (t) => {
  const { root, path } = await project(t);
  await mkdir(path);
  const result = await readProjectVocabulary(root);
  assert.deepEqual(result.terms, []);
  assert.match(result.warning!, /could not read/);
});

test("limits apply after normalization and reject oversized lists explicitly", async (t) => {
  const { root, path } = await project(t);
  const terms = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, i) => `term${i}`);
  await writeFile(path, JSON.stringify({ terms: [...terms, ...terms] }));
  assert.deepEqual((await readProjectVocabulary(root)).terms, terms);
  await writeFile(path, JSON.stringify({ terms: [...terms, "extra"] }));
  assert.match((await readProjectVocabulary(root)).warning!, /distinct terms/);
  await writeFile(path, JSON.stringify({ terms: ["a".repeat(MAX_VOCABULARY_CHARACTERS)] }));
  assert.equal((await readProjectVocabulary(root)).warning, undefined);
  await writeFile(path, JSON.stringify({ terms: ["a".repeat(MAX_VOCABULARY_CHARACTERS + 1)] }));
  assert.match((await readProjectVocabulary(root)).warning!, /UTF-16/);
});

test("snapshots stay independent across edits and project changes", async (t) => {
  const first = await project(t);
  const second = await project(t);
  await writeFile(first.path, '{"terms":["Dolt"]}');
  const snapshot = await readProjectVocabulary(first.root);
  await writeFile(first.path, '{"terms":["LanceDB"]}');
  assert.deepEqual((await readProjectVocabulary(first.root)).terms, ["LanceDB"]);
  assert.deepEqual(await readProjectVocabulary(second.root), { terms: [] });
  assert.deepEqual(snapshot.terms, ["Dolt"]);
});

test("manual vocabulary keeps its order and spelling; automatic terms fill remaining slots", () => {
  assert.deepEqual(mergeVocabulary(["Dolt", "dolt"], ["Dolt", "Qwen3-ASR", "Qwen3-ASR", ""]),
    ["Dolt", "dolt", "Qwen3-ASR"]);
  const manual = Array.from({ length: MAX_VOCABULARY_TERMS - 1 }, (_, i) => `manual${i}`);
  assert.deepEqual(mergeVocabulary(manual, ["extra", "overflow"]), [...manual, "extra"]);
  manual.push("lastManual");
  assert.deepEqual(mergeVocabulary(manual, ["extra"]), manual);
});

test("64 automatic terms fit alongside 64 manual terms", () => {
  const manual = Array.from({ length: 64 }, (_, i) => `Manual${i}`);
  const automatic = Array.from({ length: 64 }, (_, i) => `Auto${i}`);
  assert.deepEqual(mergeVocabulary(manual, automatic), [...manual, ...automatic]);
  assert.equal(mergeVocabulary(manual, [...automatic, "overflow"]).length, 128);
});

test("automatic terms never displace manual terms to fit the character budget", () => {
  const manual = ["a".repeat(MAX_VOCABULARY_CHARACTERS - 4)];
  assert.deepEqual(mergeVocabulary(manual, ["too-long", "😀", "Pi", "extra"]), [...manual, "😀", "Pi"]);
  assert.deepEqual(mergeVocabulary(["a".repeat(MAX_VOCABULARY_CHARACTERS)], ["Pi"]),
    ["a".repeat(MAX_VOCABULARY_CHARACTERS)]);
});

test("each recording snapshots the latest completed automatic vocabulary exactly once", async t => {
  const { root, path } = await project(t);
  await writeFile(path, '{"terms":["Dolt"]}');
  let automatic = ["LanceDB"];
  let reads = 0;
  const getAutomatic = () => { reads++; return automatic; };
  const first = await readDictationVocabulary(root, getAutomatic);
  automatic[0] = "DuckDB";
  const second = await readDictationVocabulary(root, getAutomatic);
  automatic = []; // Session reset must affect the next recording, not an existing one.
  const third = await readDictationVocabulary(root, getAutomatic);
  assert.deepEqual(first.terms, ["Dolt", "LanceDB"]);
  assert.deepEqual(second.terms, ["Dolt", "DuckDB"]);
  assert.deepEqual(third.terms, ["Dolt"]);
  assert.ok(Object.isFrozen(first.terms));
  assert.equal(reads, 3);
});

test("missing or invalid manual files still permit automatic terms, preserving warnings", async t => {
  const { root, path } = await project(t);
  assert.deepEqual(await readDictationVocabulary(root, () => ["Qwen3-ASR"]), { terms: ["Qwen3-ASR"] });
  await writeFile(path, "invalid JSON");
  const snapshot = await readDictationVocabulary(root, () => ["Qwen3-ASR"]);
  assert.deepEqual(snapshot.terms, ["Qwen3-ASR"]);
  assert.match(snapshot.warning!, /expected valid JSON/);
});
