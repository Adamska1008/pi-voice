import assert from "node:assert/strict";
import test from "node:test";
import { VocabularyCache } from "../src/vocabulary-cache.js";

test("sorts by actual mentions, not extraction order or repeated scans", () => {
  const cache = new VocabularyCache();
  const observations = [{ position: 1, text: "Dolt" }, { position: 2, text: "LanceDB" }];
  cache.update(["Dolt", "LanceDB", "invented"], observations);
  assert.deepEqual(cache.snapshot(), ["LanceDB", "Dolt"]);
  cache.update(["Dolt"], observations.slice(0, 1));
  assert.deepEqual(cache.snapshot(), ["LanceDB", "Dolt"]);
  cache.update([], [{ position: 3, text: "继续用Dolt。" }]);
  assert.deepEqual(cache.snapshot(), ["Dolt", "LanceDB"]);
});

test("capacity evicts the least recently mentioned term, including late old discoveries", () => {
  const cache = new VocabularyCache(2);
  cache.update(["Dolt", "LanceDB"], [{ position: 1, text: "Dolt" }, { position: 2, text: "LanceDB" }]);
  const old = cache.snapshot();
  cache.update(["DuckDB"], [{ position: 3, text: "DuckDB" }]);
  cache.update(["Meilisearch"], [{ position: 0, text: "Meilisearch" }]);
  assert.deepEqual(cache.snapshot(), ["DuckDB", "LanceDB"]);
  assert.deepEqual(old, ["LanceDB", "Dolt"]);
  assert.ok(Object.isFrozen(old));
});

test("empty extraction preserves candidates; clearing a branch removes them", () => {
  const cache = new VocabularyCache();
  cache.update(["Pi"], [{ position: 0, text: "Pi" }]);
  cache.update([], [{ position: 1, text: "无新术语" }]);
  assert.deepEqual(cache.snapshot(), ["Pi"]);
  cache.clear();
  assert.deepEqual(cache.snapshot(), []);
});

test("identifier substrings do not refresh terms, while Chinese adjacency does", () => {
  const cache = new VocabularyCache();
  cache.update(["Pi", "Dolt"], [{ position: 0, text: "Pi" }, { position: 1, text: "Dolt" }]);
  cache.update([], [{ position: 2, text: "Pipeline myPi Pi_model" }]);
  assert.deepEqual(cache.snapshot(), ["Dolt", "Pi"]);
  cache.update([], [{ position: 3, text: "使用Pi来处理" }]);
  assert.deepEqual(cache.snapshot(), ["Pi", "Dolt"]);
});

test("output remains capped at 64 and reading snapshots does not refresh recency", () => {
  const cache = new VocabularyCache();
  const words = Array.from({ length: 134 }, (_, i) => `Term${i}`);
  cache.update(words, words.map((text, position) => ({ text, position })));
  assert.equal(cache.entries().length, 128);
  assert.deepEqual(cache.snapshot(), words.slice(-64).reverse());
  assert.deepEqual(cache.snapshot(), words.slice(-64).reverse());
  cache.update([], [{ position: 200, text: "Term0" }]); // Evicted, so cannot refresh without rediscovery.
  assert.deepEqual(cache.snapshot(), words.slice(-64).reverse());
  cache.update([], [{ position: 201, text: "Term6" }]); // Oldest surviving candidate can return to the front.
  assert.equal(cache.snapshot()[0], "Term6");
});
