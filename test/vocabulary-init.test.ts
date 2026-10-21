import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createVocabularyInitializer } from "../src/vocabulary-init.js";

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "voice-init-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "README.md"), "Qwen3-ASR");
  return { cwd, ctx: { cwd } as ExtensionContext, destination: join(cwd, ".pi", "voice-vocabulary.json") };
}

test("one task per project saves a complete file and leaves no temporary files", async t => {
  const { cwd, ctx, destination } = await fixture(t);
  let calls = 0;
  const init = createVocabularyInitializer({ extract: async () => { calls++; return ["Qwen3-ASR"]; } });
  assert.deepEqual(await Promise.all([init.start(ctx), init.start(ctx)]), ["saved", "saved"]);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { terms: ["Qwen3-ASR"] });
  assert.deepEqual(await readdir(join(cwd, ".pi")), ["voice-vocabulary.json"]);
  await init.shutdown();
  assert.equal(await init.start(ctx), "cancelled");
});

test("existing files, even invalid ones, are never replaced or sent for extraction", async t => {
  const { cwd, ctx, destination } = await fixture(t);
  await mkdir(join(cwd, ".pi"));
  await writeFile(destination, "user content");
  const init = createVocabularyInitializer({ extract: async () => { throw new Error("must not extract"); } });
  assert.equal(await init.start(ctx), "exists");
  assert.equal(await readFile(destination, "utf8"), "user content");
});

test("a file created during extraction wins; temporary output is removed", async t => {
  const { cwd, ctx, destination } = await fixture(t);
  const init = createVocabularyInitializer({ extract: async () => {
    await mkdir(join(cwd, ".pi"));
    await writeFile(destination, "user content");
    return ["Qwen3-ASR"];
  } });
  assert.equal(await init.start(ctx), "exists");
  assert.equal(await readFile(destination, "utf8"), "user content");
  assert.deepEqual(await readdir(join(cwd, ".pi")), ["voice-vocabulary.json"]);
});

test("shutdown rejects late results and is idempotent", async t => {
  const { ctx, destination } = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: (terms: string[]) => void;
  const init = createVocabularyInitializer({ extract: async () => {
    entered(); return new Promise<string[]>(resolve => { finish = resolve; });
  } });
  const task = init.start(ctx);
  await started;
  await init.shutdown(); // Must not wait for a provider that ignores cancellation.
  assert.equal(await task, "cancelled");
  finish(["Qwen3-ASR"]);
  await new Promise(resolve => setImmediate(resolve));
  await init.shutdown();
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

test("failed requests do not retry; empty selection is a saved initialization", async t => {
  const { ctx, destination } = await fixture(t);
  let calls = 0;
  const failed = createVocabularyInitializer({ extract: async () => { calls++; throw new Error("failure"); } });
  assert.equal(await failed.start(ctx), "failed");
  assert.equal(await failed.start(ctx), "failed");
  assert.equal(calls, 1);
  const empty = createVocabularyInitializer({ extract: async () => [] });
  assert.equal(await empty.start(ctx), "saved");
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { terms: [] });
});

for (const outcome of ["saved", "exists", "failed"] as const) {
  test(`shutdown drains pending publication and reports ${outcome}`, async t => {
    const { cwd, ctx, destination } = await fixture(t);
    let entered!: () => void;
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const init = createVocabularyInitializer({ extract: async () => ["Qwen3-ASR"], publish: async (source, target) => {
      entered();
      await paused;
      if (outcome === "failed") throw new Error("publish failed");
      if (outcome === "exists") await writeFile(destination, "user content");
      await link(source, target);
    } });
    const task = init.start(ctx);
    await publishing;
    let closed = false;
    const shutdown = init.shutdown().then(() => { closed = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false, "shutdown must wait for filesystem publication");
    } finally { release(); }
    assert.equal(await task, outcome);
    await shutdown;
    assert.deepEqual(await readdir(join(cwd, ".pi")), outcome === "failed" ? [] : ["voice-vocabulary.json"]);
    if (outcome === "saved") assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { terms: ["Qwen3-ASR"] });
    if (outcome === "exists") assert.equal(await readFile(destination, "utf8"), "user content");
  });
}

test("root-resolution failure is retained even if the directory later appears", async t => {
  const { cwd } = await fixture(t);
  const missing = join(cwd, "missing");
  const ctx = { cwd: missing } as ExtensionContext;
  let calls = 0;
  const init = createVocabularyInitializer({ extract: async () => { calls++; return []; } });
  assert.deepEqual(await Promise.all([init.start(ctx), init.start(ctx)]), ["failed", "failed"]);
  await mkdir(missing);
  await writeFile(join(missing, "README.md"), "Qwen3-ASR");
  assert.equal(await init.start(ctx), "failed");
  assert.equal(calls, 0);
  await init.shutdown();
});

test("missing README skips extraction; timeout cancels cooperative requests", async t => {
  const { cwd, ctx, destination } = await fixture(t);
  const timed = createVocabularyInitializer({ timeoutMs: 5, extract: async (_ctx, _docs, signal) => {
    await new Promise<void>((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1000);
      const cancel = () => { clearTimeout(keepAlive); reject(new Error("cancelled")); };
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    });
    return [];
  } });
  assert.equal(await timed.start(ctx), "cancelled");
  await assert.rejects(readFile(destination), { code: "ENOENT" });
  await rm(join(cwd, "README.md"));
  const missing = createVocabularyInitializer({ extract: async () => { throw new Error("must not extract"); } });
  assert.equal(await missing.start(ctx), "skipped");
});
