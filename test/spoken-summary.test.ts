import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateSpokenSummary } from "../src/spoken-summary.js";

const assistant = (text: string, stopReason = "stop") => ({ type: "message", message: {
  role: "assistant", stopReason, content: [{ type: "thinking", thinking: "private thinking" }, { type: "text", text }],
} });
function fixture(branch: any[] = [assistant("已完成修改，但还没有验证。请重新加载。")]) {
  const calls: any[] = [];
  let response: any = { stopReason: "stop", content: [{ type: "text", text: "修改好了，还没验证。你重新加载一下。" }] };
  let result = async () => response;
  const streamSimple = (...args: any[]) => { calls.push(args); return { result }; };
  const ctx = {
    model: { provider: "test", id: "model" },
    sessionManager: { getBranch: () => branch },
    modelRegistry: { streamSimple, getProvider: () => ({ streamSimple }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only" }) },
  } as unknown as ExtensionContext;
  return { ctx, calls, setResponse: (value: any) => { response = value; }, setResult: (fn: typeof result) => { result = fn; } };
}

test("uses latest complete assistant prose from current branch without mutating it", async () => {
  const branch = [assistant("old"), assistant("完成了。\n```ts\nsecretCode();\n```\n未验证。"),
    { type: "message", message: { role: "toolResult", content: "private tool output" } },
    assistant("partial", "length"), assistant("tool preamble", "toolUse"), assistant("failed", "error")];
  const before = structuredClone(branch);
  const f = fixture(branch);
  assert.equal(await generateSpokenSummary(f.ctx, new AbortController().signal), "修改好了，还没验证。你重新加载一下。");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].messages[0].content, "完成了。\n未验证。");
  assert.match(f.calls[0][1].systemPrompt, /不得把计划说成已完成/);
  assert.equal(f.calls[0][2].maxRetries, 0);
  assert.deepEqual(branch, before);
});

test("absent, blank and code-only replies do not dispatch", async () => {
  for (const branch of [[], [assistant(" ")], [assistant("```js\ncode\n```")]]) {
    const f = fixture(branch);
    assert.equal(await generateSpokenSummary(f.ctx, new AbortController().signal), undefined);
    assert.equal(f.calls.length, 0);
  }
});

test("oversized input is rejected instead of truncating caveats", async () => {
  const f = fixture([assistant("中".repeat(12000) + "尚未验证")]);
  await assert.rejects(generateSpokenSummary(f.ctx, new AbortController().signal), /too long/);
  assert.equal(f.calls.length, 0);
});

test("rejects empty, oversized, fenced and incomplete output", async () => {
  for (const [text, stopReason] of [["", "stop"], ["中".repeat(601), "stop"], ["```js\ncode\n```", "stop"], ["partial", "length"]]) {
    const f = fixture();
    f.setResponse({ stopReason, content: [{ type: "text", text }] });
    await assert.rejects(generateSpokenSummary(f.ctx, new AbortController().signal), /response/);
  }
});

test("supports legacy auth and does not fall back after modern failure", async () => {
  const legacy = fixture();
  delete (legacy.ctx.modelRegistry as any).streamSimple;
  await generateSpokenSummary(legacy.ctx, new AbortController().signal);
  assert.equal(legacy.calls[0][2].apiKey, "test-only");
  const modern = fixture();
  modern.setResult(async () => { throw new Error("provider failure"); });
  await assert.rejects(generateSpokenSummary(modern.ctx, new AbortController().signal), /provider failure/);
  assert.equal(modern.calls.length, 1);
});

test("times out even when a provider ignores the abort signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.setResult(() => new Promise(() => {}));
  const task = generateSpokenSummary(f.ctx, new AbortController().signal);
  const rejected = assert.rejects(task, /timed out/);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(f.calls[0][2].signal.aborted, true);
});

test("cancels before dispatch and without waiting for an uncooperative provider", async () => {
  const f = fixture();
  await assert.rejects(generateSpokenSummary(f.ctx, AbortSignal.abort()));
  assert.equal(f.calls.length, 0);
  let finish!: (response: any) => void;
  f.setResult(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const task = generateSpokenSummary(f.ctx, controller.signal);
  controller.abort();
  await assert.rejects(task);
  assert.equal(f.calls[0][2].signal.aborted, true);
  finish({ stopReason: "stop", content: [{ type: "text", text: "late" }] });
});
