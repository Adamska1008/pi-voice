import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractVocabulary, registerVocabularyBackground } from "../src/vocabulary-background.js";
import { log } from "../src/log.js";

function fixture() {
  const handlers = new Map<string, Function>();
  const messages: any[] = [];
  const calls: any[] = [];
  const warnings: string[] = [];
  let reply: () => Promise<any> = async () => ({ stopReason: "stop", content: [{ type: "text", text: '["Qwen3-ASR"]' }] });
  const ctx = {
    model: { provider: "test", id: "selected-model" }, isIdle: () => true,
    sessionManager: { getSessionId: () => "test-session", getBranch: () => messages.map((message, index) => message.type === "custom"
      ? { ...message, id: `entry${index}` } : { type: "message", id: `entry${index}`, message }) },
    ui: { notify: (text: string) => warnings.push(text) },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only", headers: { example: "header" } }),
      getProvider: () => ({ streamSimple: (...args: any[]) => { calls.push(args); return { result: reply }; } }),
    },
  } as unknown as ExtensionContext;
  const getTerms = registerVocabularyBackground({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    appendEntry: (customType: string, data: unknown) => messages.push({ type: "custom", customType, data: structuredClone(data) }),
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const user = (content: string) => {
    const message = { role: "user", content };
    messages.push(message); emit("message_end", { message });
  };
  return { ctx, calls, warnings, getTerms, emit, user, messages, setReply: (fn: typeof reply) => { reply = fn; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("modern registry receives extraction instructions and owns authentication", async t => {
  const f = fixture();
  const registry = f.ctx.modelRegistry;
  t.mock.method(registry, "getProvider", () => { throw new Error("must not bypass registry"); });
  t.mock.method(registry, "getApiKeyAndHeaders", async () => { throw new Error("registry owns auth"); });
  let calls = 0;
  Object.assign(registry, { streamSimple(model: unknown, context: any, options: any) {
    assert.equal(this, registry);
    calls++;
    assert.equal(model, f.ctx.model);
    assert.match(context.systemPrompt, /Return ONLY a JSON array of strings/);
    assert.equal(context.messages[0].content, "Explain Qwen3-ASR");
    assert.equal(options.apiKey, undefined);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.maxTokens, 512);
    return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '["Qwen3-ASR"]' }] }) };
  } });
  assert.deepEqual(await extractVocabulary(f.ctx, "Explain Qwen3-ASR", new AbortController().signal), ["Qwen3-ASR"]);
  await assert.rejects(extractVocabulary(f.ctx, "Explain Qwen3-ASR", AbortSignal.abort()));
  assert.equal(calls, 1);
});

test("usage traces report provider counters without source text or invented zeroes", async t => {
  const lines: string[] = [];
  t.mock.method(log, "info", (line: string) => lines.push(line));
  const f = fixture();
  const usage = { input: 20, output: 4, cacheRead: 10, cacheWrite: 0, totalTokens: 34, secret: "private" };
  const response = (text: string, counters?: unknown) => ({
    stopReason: "stop", content: [{ type: "text", text }], usage: counters,
  });
  for (const value of [response("[]", usage), response("private-invalid", usage), response("[]")]) {
    f.setReply(async () => value);
    await extractVocabulary(f.ctx, "private-source", new AbortController().signal).catch(() => undefined);
  }
  f.setReply(async () => { throw new Error("private-provider-error"); });
  await assert.rejects(extractVocabulary(f.ctx, "private-source", new AbortController().signal));
  const abort = new AbortController();
  f.setReply(async () => { abort.abort(); return response("[]", usage); });
  await assert.rejects(extractVocabulary(f.ctx, "private-source", abort.signal));
  const traces = lines.filter(line => line.startsWith("voice vocabulary usage: "))
    .map(line => JSON.parse(line.slice("voice vocabulary usage: ".length)));
  assert.equal(traces.length, 5);
  assert.deepEqual(traces.map(trace => trace.status), ["success", "error", "success", "error", "cancelled"]);
  assert.deepEqual(traces[0].tokens, { input: 20, output: 4, cacheRead: 10, cacheWrite: 0, totalTokens: 34 });
  assert.deepEqual(traces[1].tokens, traces[0].tokens); // Invalid JSON can still consume tokens.
  assert.equal(traces[0].usageStatus, "reported");
  for (const index of [2, 3]) {
    assert.equal(traces[index].usageStatus, "unknown-or-partial");
    assert.ok(Object.values(traces[index].tokens).every(value => value === null));
  }
  assert.equal(new Set(traces.map(trace => trace.requestId)).size, 5);
  for (const trace of traces) {
    assert.equal(trace.sessionId, "test-session");
    assert.equal(trace.model, "selected-model");
    assert.equal(trace.provider, "test");
    assert.ok(trace.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(traces), /private|test-only/);
});

test("extraction accepts 64 source terms and caps larger responses", async () => {
  const f = fixture();
  const terms = Array.from({ length: 65 }, (_, i) => `Term${i}`);
  f.setReply(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(terms) }] }));
  assert.deepEqual(await extractVocabulary(f.ctx, terms.join(" "), new AbortController().signal), terms.slice(0, 64));
});

test("a modern registry failure never falls back to an unnormalized provider request", async t => {
  const f = fixture();
  t.mock.method(f.ctx.modelRegistry, "getProvider", () => { throw new Error("unexpected fallback"); });
  Object.assign(f.ctx.modelRegistry, { streamSimple: () => ({ result: async () => { throw new Error("registry failure"); } }) });
  await assert.rejects(extractVocabulary(f.ctx, "Qwen3-ASR", new AbortController().signal), /registry failure/);
});

test("diagnostics distinguish extraction results/failures without logging source or provider text", async t => {
  const lines: string[] = [];
  t.mock.method(log, "info", (line: string) => lines.push(line));
  t.mock.method(log, "warn", (line: string) => lines.push(line));
  const f = fixture();
  t.after(() => f.emit("session_shutdown"));
  f.emit("session_start");
  f.user("Qwen3-ASR private-conversation"); f.emit("agent_settled"); await flush();
  const failures: Array<[() => Promise<any>, string]> = [
    [async () => ({ stopReason: "stop", content: [{ type: "text", text: "private-invalid-json" }] }), "invalid-json"],
    [async () => ({ stopReason: "length", content: [] }), "incomplete-length"],
    [async () => { throw Object.assign(new Error("secret-provider-response"), { status: 429 }); }, "provider-or-auth-error status=429"],
  ];
  for (const [reply, reason] of failures) {
    const failed = fixture();
    failed.setReply(reply); failed.user("private-conversation"); failed.emit("agent_settled"); await flush();
    assert.ok(lines.some(line => line.includes(`extraction failed: reason=${reason}`)));
    failed.emit("session_shutdown");
  }
  assert.doesNotMatch(lines.join("\n"), /Qwen3-ASR|private-|secret-|test-only/);
});

test("diagnostics identify extraction timeout without exposing the abort error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines: string[] = [];
  t.mock.method(log, "warn", (line: string) => lines.push(line));
  const f = fixture();
  t.after(() => f.emit("session_shutdown"));
  t.mock.method(f.ctx.modelRegistry, "getProvider", () => ({
    streamSimple: (_model: unknown, _context: unknown, options: any) => ({
      result: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private-abort")))),
    }),
  }));
  f.user("private-conversation"); f.emit("agent_settled"); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.ok(lines.some(line => line.includes("reason=timeout")));
  assert.doesNotMatch(lines.join("\n"), /private-/);
});

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

test("a fresh extension restores saved terms without a model call or duplicate checkpoint", async t => {
  const first = fixture();
  first.user("Use Qwen3-ASR"); first.emit("agent_settled"); await flush();
  const saved = JSON.parse(JSON.stringify(first.messages));
  assert.equal(saved.filter((entry: any) => entry.type === "custom").length, 1);
  first.emit("session_shutdown");
  const resumed = fixture();
  t.after(() => resumed.emit("session_shutdown"));
  resumed.messages.push(...saved);
  resumed.emit("session_start");
  assert.deepEqual(resumed.getTerms(), ["Qwen3-ASR"]);
  resumed.emit("agent_settled"); await flush();
  assert.equal(resumed.calls.length, 0);
  assert.equal(resumed.messages.length, saved.length);
  resumed.messages.length = 0; resumed.emit("session_tree");
  assert.deepEqual(resumed.getTerms(), []);
  resumed.messages.push(...saved); resumed.emit("session_tree");
  assert.deepEqual(resumed.getTerms(), ["Qwen3-ASR"]);
});
