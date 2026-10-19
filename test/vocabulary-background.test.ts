import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVocabulary, registerVocabularyBackground } from "../src/vocabulary-background.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDictationVocabulary } from "../src/vocabulary.js";
import { DictationController } from "../src/dictation-controller.js";
import { settingsForModel } from "../src/settings.js";
import { FakeMicrophone, fakeDictationService } from "./dictation-helper.js";

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

test("known conversation terms refresh without extraction and code blocks do not refresh them", async t => {
  const f = fixture();
  t.after(() => f.emit("session_shutdown"));
  f.setReply(async () => ({ stopReason: "stop", content: [{ type: "text", text: '["Pi","Qwen3-ASR"]' }] }));
  f.user("Pi");
  f.messages.push({ role: "assistant", stopReason: "stop", content: "Qwen3-ASR" });
  f.emit("agent_settled"); await flush();
  assert.deepEqual(f.getTerms(), ["Qwen3-ASR", "Pi"]);
  f.user("继续使用Pi");
  f.messages.push({ role: "assistant", stopReason: "stop", content: "```\nQwen3-ASR\n```" });
  f.messages.push({ role: "assistant", stopReason: "error", content: "Qwen3-ASR" });
  f.messages.push({ role: "toolResult", content: "Qwen3-ASR" });
  f.emit("agent_settled"); await flush();
  assert.deepEqual(f.getTerms(), ["Pi", "Qwen3-ASR"]);
  assert.equal(f.calls.length, 1);
});

test("late extraction uses newer mentions accumulated while the request was running", async t => {
  const f = fixture();
  t.after(() => f.emit("session_shutdown"));
  let finish!: (value: any) => void;
  f.setReply(() => new Promise(resolve => { finish = resolve; }));
  f.user("Pi");
  f.messages.push({ role: "assistant", stopReason: "stop", content: "Qwen3-ASR" });
  f.emit("agent_settled"); await flush();
  f.user("继续使用Pi"); f.emit("agent_settled");
  finish({ stopReason: "stop", content: [{ type: "text", text: '["Pi","Qwen3-ASR"]' }] });
  await flush();
  assert.deepEqual(f.getTerms(), ["Pi", "Qwen3-ASR"]);
  assert.equal(f.calls.length, 1);
});

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

test("extracted vocabulary reaches dictation and a branch reset only affects future snapshots", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-background-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  t.after(() => f.emit("session_shutdown"));
  f.user("Use Qwen3-ASR"); f.emit("agent_settled"); await flush();
  const snapshot = await readDictationVocabulary(root, f.getTerms);
  const service = fakeDictationService();
  const received: Array<readonly string[] | undefined> = [];
  const controller = new DictationController({
    reserveDictation(_settings, vocabulary) {
      received.push(vocabulary);
      return service.reserveDictation();
    },
  }, { openCapture: new FakeMicrophone().open, vocabulary: snapshot.terms });
  t.after(() => controller.dispose());
  await controller.start(settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model"));
  f.emit("session_tree");
  assert.deepEqual(received, [["Qwen3-ASR"]]);
  assert.deepEqual(snapshot.terms, ["Qwen3-ASR"]);
  assert.deepEqual((await readDictationVocabulary(root, f.getTerms)).terms, []);
});
