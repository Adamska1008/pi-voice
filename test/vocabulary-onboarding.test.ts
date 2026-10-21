import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InitializationResult } from "../src/vocabulary-init.js";
import { createVocabularyOnboarding } from "../src/vocabulary-onboarding.js";

async function fixture(t: test.TestContext, approved = true) {
  const cwd = await mkdtemp(join(tmpdir(), "voice-consent-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let prompts = 0, starts = 0, shutdowns = 0;
  const notifications: string[] = [];
  let confirm = async () => approved;
  let finish!: (result: InitializationResult) => void;
  const ctx = { cwd, hasUI: true, model: { provider: "test", id: "model" }, ui: {
    confirm: async () => { prompts++; return confirm(); },
    notify: (message: string) => notifications.push(message),
  } } as unknown as ExtensionContext;
  const gate = createVocabularyOnboarding({
    start: async () => { starts++; return new Promise<InitializationResult>(resolve => { finish = resolve; }); },
    shutdown: async () => { shutdowns++; },
  });
  return { cwd, ctx, gate, notifications, counts: () => ({ prompts, starts, shutdowns }),
    reply: (result: InitializationResult) => finish(result), setConfirm: (fn: typeof confirm) => { confirm = fn; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("approval defers generation until recording starts; completion notifies once", async t => {
  const f = await fixture(t);
  const begin = await f.gate.prepare(f.ctx);
  assert.deepEqual(f.counts(), { prompts: 1, starts: 0, shutdowns: 0 });
  begin(); begin();
  assert.equal(f.counts().starts, 1);
  assert.deepEqual(f.notifications, []);
  f.reply("saved"); await flush();
  assert.match(f.notifications[0]!, /next recording/);
  (await f.gate.prepare(f.ctx))();
  assert.equal(f.counts().prompts, 1);
});

test("declining and existing invalid files skip initialization", async t => {
  const declined = await fixture(t, false);
  (await declined.gate.prepare(declined.ctx))();
  (await declined.gate.prepare(declined.ctx))();
  assert.deepEqual(declined.counts(), { prompts: 1, starts: 0, shutdowns: 0 });
  const existing = await fixture(t);
  await mkdir(join(existing.cwd, ".pi"));
  await writeFile(join(existing.cwd, ".pi", "voice-vocabulary.json"), "invalid user file");
  (await existing.gate.prepare(existing.ctx))();
  assert.equal(existing.counts().prompts, 0);
});

test("shutdown silences late completion and prevents starts after pending consent", async t => {
  const f = await fixture(t);
  (await f.gate.prepare(f.ctx))();
  await f.gate.shutdown();
  f.reply("saved"); await flush();
  assert.deepEqual(f.notifications, []);
  const pending = await fixture(t);
  let approve!: (value: boolean) => void;
  let entered!: () => void;
  const asked = new Promise<void>(resolve => { entered = resolve; });
  pending.setConfirm(() => { entered(); return new Promise(resolve => { approve = resolve; }); });
  const prepare = pending.gate.prepare(pending.ctx);
  await asked;
  await pending.gate.shutdown();
  approve(true); (await prepare)();
  assert.equal(pending.counts().starts, 0);
});

test("no UI skips prompting; failed initialization reports without retry", async t => {
  const f = await fixture(t);
  (await f.gate.prepare({ ...f.ctx, hasUI: false }))();
  assert.equal(f.counts().prompts, 0);
  (await f.gate.prepare(f.ctx))();
  f.reply("failed"); await flush();
  assert.match(f.notifications[0]!, /recording is unaffected/);
  (await f.gate.prepare(f.ctx))();
  assert.equal(f.counts().starts, 1);
});
