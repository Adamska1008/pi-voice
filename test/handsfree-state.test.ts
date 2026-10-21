import assert from "node:assert/strict";
import test from "node:test";
import { HandsFreeSegmenter, HandsFreeState } from "../src/handsfree-state.js";

function draft(text = "请帮我写一个发送邮件的函数") {
  const state = new HandsFreeState();
  assert.equal(state.wake(), true);
  assert.deepEqual(state.finish(state.beginRecognition()!, text), { type: "draft", text });
  return state;
}
test("dictation never executes commands; only independent confirmation in command state sends", () => {
  const state = draft("确认发送");
  for (const text of ["发送", "不要确认发送", "请确认发送", "确认发送然后继续", "取消", "继续说的话"]) {
    assert.deepEqual(state.finish(state.beginRecognition()!, text), { type: "none" });
    assert.equal(state.phase, "command");
  }
  const ticket = state.beginRecognition()!;
  assert.deepEqual(state.finish(ticket, "确认发送。"), { type: "send", text: "确认发送" });
  assert.equal(state.phase, "wake");
  assert.deepEqual(state.finish(ticket, "确认发送"), { type: "none" });
});
test("continue appends, cancel clears, timeout preserves unsent editor draft", () => {
  const state = draft("第一段");
  state.finish(state.beginRecognition()!, "继续");
  assert.equal(state.phase, "dictation");
  assert.deepEqual(state.finish(state.beginRecognition()!, "第二段"), { type: "draft", text: "第一段\n第二段" });
  state.timeout();
  assert.equal(state.phase, "wake");
  assert.equal(state.draft, "第一段\n第二段");
  state.wake();
  assert.equal(state.phase, "command");
  assert.deepEqual(state.finish(state.beginRecognition()!, "取消输入！"), { type: "draft", text: "" });
});
test("pause, shutdown and branch changes invalidate late recognition tickets", () => {
  const state = draft();
  const ticket = state.beginRecognition()!;
  state.pause(); state.resume(); state.wake();
  assert.deepEqual(state.finish(ticket, "确认发送"), { type: "none" });
  const pending = state.beginRecognition()!;
  state.stop();
  assert.deepEqual(state.finish(pending, "确认发送"), { type: "none" });
  assert.equal(state.wake(), false);
});
test("empty input cannot send and oversized drafts are rejected", () => {
  const state = draft("");
  assert.equal(state.phase, "wake");
  state.wake();
  assert.throws(() => state.finish(state.beginRecognition()!, "a".repeat(8001)), /8000/);
  assert.equal(state.draft, "");
});
test("VAD segments bounded speech, discards short noise and never emits idle silence", () => {
  const segmenter = new HandsFreeSegmenter();
  const frame = new Float32Array(512);
  for (let i = 0; i < 10000; i++) assert.equal(segmenter.push(frame, 0, false), undefined);
  for (let i = 0; i < 4; i++) segmenter.push(frame, 0.9, false);
  for (let i = 0; i < 40; i++) assert.equal(segmenter.push(frame, 0, false), undefined);
  for (let i = 0; i < 10; i++) segmenter.push(frame, 0.9, true);
  for (let i = 0; i < 31; i++) assert.equal(segmenter.push(frame, 0, true), undefined);
  assert.ok(segmenter.push(frame, 0, true)!.length > 10 * 512);
  assert.throws(() => { for (let i = 0; i < 251; i++) segmenter.push(frame, 0.9, true); }, /too long/);
});
