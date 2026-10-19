import assert from "node:assert/strict";
import test from "node:test";
import { buildRecentVoiceContext as build, type VoiceContextMessage } from "../src/conversation-context.js";

const count = (text: string) => Array.from(text).length;
const user = (text: string): VoiceContextMessage => ({ role: "user", content: text });
const assistant = (text: string): VoiceContextMessage => ({ role: "assistant", content: text, stopReason: "stop" });

test("keeps recent whole turns in chronological order, including an unanswered user", () => {
  const latest = "用户：new\n\n助手：reply\n\n用户：next";
  const messages = [user("old"), assistant("old reply"), user("new"), assistant("reply"), user("next")];
  assert.equal(build(messages, count, count(latest)), latest);
  assert.equal(build(messages.slice(-1), count), "用户：next");
  assert.equal(build([], count), "");
});

test("excludes tool output, thinking, calls, failed/partial replies and orphan assistants", () => {
  const messages: VoiceContextMessage[] = [assistant("orphan"), user("question"),
    { role: "toolResult", content: "secret log" },
    { role: "assistant", stopReason: "toolUse", content: [
      { type: "thinking", text: "private reasoning" }, { type: "toolCall", text: "arguments" },
      { type: "text", text: "Checking `reserveDictation`." },
    ] },
    { ...assistant("failed"), stopReason: "error" },
    { ...assistant("cancelled"), stopReason: "aborted" },
    { ...assistant("unfinished"), stopReason: undefined }, assistant("done"),
  ];
  assert.equal(build(messages, count), "用户：question\n\n助手：Checking `reserveDictation`.\n\ndone");
});

test("drops backtick and tilde fences, retaining inline names and prose", () => {
  const text = "before `File.ts`\n```ts\nsecret\n```\nafter\n~~~~\nmore code\n~~~~\nend\n```\nunclosed";
  assert.equal(build([user(text)], count), "用户：before `File.ts`\nafter\nend");
});

test("clips an oversized latest turn at both ends without losing the user to a long reply", () => {
  const u = "目标。" + "用户中段。".repeat(200) + "不要修改。";
  const a = "结论。" + "助手中段。".repeat(400) + "下一步。";
  const result = build([user("older"), assistant("history"), user(u), assistant(a)], count);
  assert.ok(count(result) <= 1024);
  for (const text of ["目标。", "不要修改。", "结论。", "下一步。", "[中间省略]"]) assert.ok(result.includes(text));
  assert.ok(!result.includes("older"));
});

test("returns spare budget to a long user message when the assistant is short", () => {
  const result = build([user("start。" + "中段。".repeat(500) + "finish。"), assistant("OK")], count);
  assert.ok(count(result.split("助手：")[0]!) > 512);
  assert.ok(count(result) <= 1024);
  assert.ok(result.endsWith("助手：OK"));
});

test("counts labels with the injected tokenizer and handles tiny budgets and Unicode", () => {
  const messages = [user("开始😀" + "长内容😀".repeat(200) + "结束😀"), assistant("确认")];
  const weighted = (text: string) => count(text) * 3;
  for (const budget of [1, 20, 200, 1024]) {
    const result = build(messages, weighted, budget);
    assert.ok(weighted(result) <= budget);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result));
  }
  for (const budget of [0, -1, NaN, Infinity]) assert.equal(build(messages, count, budget), "");
});
