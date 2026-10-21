import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectVocabularyDocuments, DOCUMENT_LIMITS } from "../src/vocabulary-documents.js";

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "voice-documents-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(join(root, "docs"), { recursive: true });
  const put = (path: string, text: string | Buffer) => writeFile(join(root, path), text);
  return { root, base, put };
}

test("README only, missing README and empty README are valid outcomes", async t => {
  const { root, put } = await fixture(t);
  assert.equal((await collectVocabularyDocuments(root)).documents.length, 0);
  await put("README.md", "Project introduction");
  await put("docs/unlinked.md", "Not linked");
  assert.deepEqual((await collectVocabularyDocuments(root)).documents.map(d => d.path), ["README.md"]);
  await put("README.md", "");
  assert.equal((await collectVocabularyDocuments(root)).documents[0]?.text, "");
});

test("collects ordered one-hop inline and reference links, decoded and deduplicated", async t => {
  const { root, put } = await fixture(t);
  await put("README.md", '[A](./docs/a.md#first) [again](docs/a.md#second) [B][guide] [short]\n'
    + '[guide]: <docs/中文%20指南.md> "Guide"\n[short]: docs/c.md\n');
  await put("docs/a.md", "[Nested](nested.md)");
  await put("docs/中文 指南.md", "B");
  await put("docs/c.md", "C");
  await put("docs/nested.md", "Should not be read");
  const result = await collectVocabularyDocuments(root);
  assert.deepEqual(result.documents.map(d => d.path), ["README.md", "./docs/a.md", "docs/中文 指南.md", "docs/c.md"]);
});

test("ignores code/images and rejects external, source, missing, escaped and binary files", async t => {
  const { root, base, put } = await fixture(t);
  await writeFile(join(base, "outside.md"), "Outside");
  await put("README.md", '[x](https://example.com/a.md) ![image](docs/image.md) [source](src/a.ts)\n'
    + '[escape](../outside.md) [missing](missing.md) [binary](docs/binary.md) [invalid](docs/invalid.md)\n'
    + '`[code](docs/code.md)`\n```md\n[fenced](docs/fenced.md)\n```\n[anchor](#title)');
  await put("docs/binary.md", Buffer.from([0, 1]));
  await put("docs/invalid.md", Buffer.from([0xff]));
  const result = await collectVocabularyDocuments(root);
  assert.equal(result.documents.length, 1);
  assert.deepEqual(result.skipped.map(d => d.reason), ["non-local-link", "not-markdown", "outside-project", "unreadable", "not-text", "unreadable-or-invalid-utf8"]);
});

test("symlink targets cannot escape the project", async t => {
  const { root, base, put } = await fixture(t);
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside", "secret.md"), "Outside");
  await symlink(join(base, "outside"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await put("README.md", "[escape](linked/secret.md)");
  assert.equal((await collectVocabularyDocuments(root)).skipped[0]?.reason, "outside-project");
});

test("bounds file bytes, total bytes and file count without splitting UTF-8", async t => {
  const { root, put } = await fixture(t);
  const links = Array.from({ length: 10 }, (_, i) => `[${i}](docs/${i}.md)`).join("\n");
  await put("README.md", links);
  for (let i = 0; i < 10; i++) await put(`docs/${i}.md`, "short");
  assert.equal((await collectVocabularyDocuments(root)).documents.length, 9);
  for (let i = 0; i < 10; i++) await put(`docs/${i}.md`, "中".repeat(20000));
  const result = await collectVocabularyDocuments(root);
  assert.ok(result.documents.slice(1).every(d => d.truncated && !d.text.includes("�")));
  assert.ok(result.documents.every(d => Buffer.byteLength(d.text) <= DOCUMENT_LIMITS.fileBytes));
  assert.ok(result.documents.reduce((n, d) => n + Buffer.byteLength(d.text), 0) <= DOCUMENT_LIMITS.totalBytes);
});
