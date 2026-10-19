import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VocabularyCache } from "../src/vocabulary-cache.js";
import { restoreVocabulary, vocabularyState, VOCABULARY_STATE_TYPE } from "../src/vocabulary-state.js";

const message = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });
const checkpoint = (data: unknown) => ({ type: "custom", id: "checkpoint", customType: VOCABULARY_STATE_TYPE, data });
const branch = (...entries: unknown[]) => entries as SessionEntry[];

test("Pi writes the checkpoint to disk and a reopened session restores it outside model context", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = SessionManager.create(directory, directory);
  session.appendMessage({ role: "user", content: "Use Qwen3-ASR", timestamp: Date.now() });
  // Pi flushes new sessions once an assistant message exists.
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop", timestamp: Date.now() } as any);
  const entries = session.getBranch();
  const position = entries.findIndex(entry => entry.type === "message" && entry.message.role === "user");
  const cache = new VocabularyCache();
  cache.update(["Qwen3-ASR"], [{ position, text: "Use Qwen3-ASR" }]);
  session.appendCustomEntry(VOCABULARY_STATE_TYPE, vocabularyState(cache, entries));
  const path = session.getSessionFile()!;
  assert.match(await readFile(path, "utf8"), /pi-voice-vocabulary/);
  const reopened = SessionManager.open(path, directory);
  const restored = new VocabularyCache();
  restoreVocabulary(restored, reopened.getBranch());
  assert.deepEqual(restored.snapshot(), ["Qwen3-ASR"]);
  assert.equal(reopened.buildSessionContext().messages.length, 2);
});

test("source IDs preserve recency across changed positions and retain all 64 candidates", () => {
  const cache = new VocabularyCache();
  const words = Array.from({ length: 64 }, (_, i) => `Term${i}`);
  const original = branch(...words.map((text, i) => message(`source${i}`, text)));
  cache.update(words, words.map((text, position) => ({ text, position })));
  const state = JSON.parse(JSON.stringify(vocabularyState(cache, original)));
  assert.equal(state.terms.length, 64);
  const restored = new VocabularyCache();
  restoreVocabulary(restored, branch(message("extra", "unrelated"), ...original, checkpoint(state)));
  assert.deepEqual(restored.snapshot(), cache.snapshot());
  assert.equal(restored.entries().length, 64);
  restored.update([], [{ position: 100, text: "Term0" }]);
  assert.equal(restored.snapshot()[0], "Term0");
  assert.deepEqual(Object.keys(state.terms[0]).sort(), ["entryId", "text"]);
});

test("invalid checkpoints and terms without valid current-branch prose evidence are ignored", () => {
  const cache = new VocabularyCache();
  const source = message("valid", "Dolt");
  for (const data of [null, {}, { version: 2, terms: [] }, { version: 1, terms: Array(65).fill({}) }]) {
    restoreVocabulary(cache, branch(source, checkpoint(data)));
    assert.deepEqual(cache.snapshot(), []);
  }
  const terms = [{ text: "Dolt", entryId: "valid" }, { text: "Invented", entryId: "valid" },
    { text: "Meilisearch", entryId: "other-branch" }, { text: "LanceDB", entryId: "code" }, null];
  restoreVocabulary(cache, branch(source, message("code", "```\nLanceDB\n```"), checkpoint({ version: 1, terms })));
  assert.deepEqual(cache.snapshot(), ["Dolt"]);
  restoreVocabulary(cache, branch(source));
  assert.deepEqual(cache.snapshot(), []);
});
