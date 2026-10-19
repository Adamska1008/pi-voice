import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  MAX_VOCABULARY_CHARACTERS,
  MAX_VOCABULARY_TERMS,
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
