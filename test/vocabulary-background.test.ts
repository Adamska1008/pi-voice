import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVocabulary, registerVocabularyBackground } from "../src/vocabulary-background.js";

function fixture() {
  const handlers = new Map<string, Function>();
  const messages: any[] = [];
  const calls: any[] = [];
  const warnings: string[] = [];
  let reply: () => Promise<any> = async () => ({ stopReason: "stop", content: [{ type: "text", text: '["Qwen3-ASR"]' }] });
  const ctx = {
    model: { provider: "test", id: "selected-model" }, isIdle: () => true,
    sessionManager: { getBranch: () => messages.map(message => ({ type: "message", message })) },
    ui: { notify: (text: string) => warnings.push(text) },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only", headers: { example: "header" } }),
      getProvider: () => ({ streamSimple: (...args: any[]) => { calls.push(args); return { result: reply }; } }),
    },
  } as unknown as ExtensionContext;
  const getTerms = registerVocabularyBackground({ on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const user = (content: string) => {
    const message = { role: "user", content };
    messages.push(message); emit("message_end", { message });
  };
  return { ctx, calls, warnings, getTerms, emit, user, messages, setReply: (fn: typeof reply) => { reply = fn; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("events start an independent bounded request and cache only source-grounded terms", async () => {
  const f = fixture();
  f.setReply(async () => ({ stopReason: "stop", content: [{ type: "text", text: '["Qwen3-ASR","invented","Qwen3-ASR"]' }] }));
  f.user("Use Qwen3-ASR.\n```ts\nprivateCode();\n```");
  f.messages.push({ role: "toolResult", content: "private tool output" });
  f.emit("agent_settled"); await flush();
  assert.deepEqual(f.getTerms(), ["Qwen3-ASR"]);
  const [model, context, options] = f.calls[0];
  assert.equal(model, f.ctx.model);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].content, "用户：Use Qwen3-ASR.");
  assert.equal(context.tools, undefined);
  assert.equal(options.apiKey, "test-only");
  assert.equal(options.maxTokens, 512);
  f.emit("agent_settled"); await flush();
  assert.equal(f.calls.length, 1);
  f.emit("session_shutdown");
});

test("two user turns arm cooldown; new work postpones it until settled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture();
  f.user("Qwen3-ASR"); f.emit("agent_settled"); await flush();
  f.user("second"); f.emit("agent_settled");
  f.user("third"); f.emit("agent_settled");
  f.emit("agent_start"); now = 30_000; t.mock.timers.tick(30_000); await flush();
  assert.equal(f.calls.length, 1);
  f.emit("agent_settled"); await flush();
  assert.equal(f.calls.length, 2);
  f.emit("session_shutdown");
});

test("branch change aborts in-flight extraction and rejects its late result", async () => {
  const f = fixture();
  let finish!: (value: any) => void;
  f.setReply(() => new Promise(resolve => { finish = resolve; }));
  f.user("Qwen3-ASR"); f.emit("agent_settled"); await flush();
  f.emit("session_tree");
  assert.equal(f.calls[0][2].signal.aborted, true);
  finish({ stopReason: "stop", content: [{ type: "text", text: '["Qwen3-ASR"]' }] });
  await flush(); assert.deepEqual(f.getTerms(), []);
  f.emit("session_shutdown");
});

test("malformed and truncated output fail without publishing; abort before dispatch sends nothing", async () => {
  const f = fixture();
  for (const response of [{ stopReason: "stop", content: [{ type: "text", text: "not JSON" }] }, { stopReason: "length", content: [] }]) {
    f.setReply(async () => response);
    await assert.rejects(extractVocabulary(f.ctx, "Qwen3-ASR", new AbortController().signal));
  }
  const calls = f.calls.length;
  await assert.rejects(extractVocabulary(f.ctx, "Qwen3-ASR", AbortSignal.abort()));
  assert.equal(f.calls.length, calls);
});

test("long Chinese conversation is byte-bounded before dispatch", async () => {
  const f = fixture();
  f.user("Qwen3-ASR。" + "中文对话。".repeat(1000)); f.emit("agent_settled"); await flush();
  const input = f.calls[0][1].messages[0].content;
  assert.ok(Buffer.byteLength(input, "utf8") <= 1024);
  assert.ok(input.includes("Qwen3-ASR"));
  f.emit("session_shutdown");
});
