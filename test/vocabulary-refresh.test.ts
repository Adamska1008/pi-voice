import assert from "node:assert/strict";
import test from "node:test";
import { VocabularyRefresh } from "../src/vocabulary-refresh.js";

function turn(policy: VocabularyRefresh, input: string): void {
  policy.userMessage();
  policy.settled(input);
}
function start(policy: VocabularyRefresh, now: number) {
  const decision = policy.take(now);
  assert.equal(decision.kind, "start");
  if (decision.kind !== "start") throw new Error("Expected extraction request");
  return decision.request;
}

test("first settled conversation starts immediately; tool turns do not count", () => {
  const policy = new VocabularyRefresh();
  policy.settled("no user yet");
  assert.equal(policy.take(0).kind, "idle");
  turn(policy, "Qwen3-ASR");
  const request = start(policy, 0);
  assert.equal(policy.complete(request, true), true);
  for (let i = 0; i < 5; i++) {
    policy.agentStarted();
    policy.settled("tool continuation");
  }
  assert.equal(policy.take(40_000).kind, "idle");
  turn(policy, "second user");
  assert.equal(policy.take(40_000).kind, "idle");
  turn(policy, "third user");
  assert.equal(start(policy, 40_000).userTurns, 3);
});

test("cooldown rechecks busy state and uses the newest settled window", () => {
  const policy = new VocabularyRefresh();
  turn(policy, "first");
  policy.complete(start(policy, 100), true);
  turn(policy, "second");
  turn(policy, "third");
  assert.deepEqual(policy.take(10_100), { kind: "wait", delayMs: 20_000 });
  policy.userMessage();
  assert.equal(policy.take(30_100).kind, "idle");
  policy.settled("fourth");
  assert.equal(start(policy, 30_100).input, "fourth");
});

test("one in-flight request; new turns remain pending after its completion", () => {
  const policy = new VocabularyRefresh();
  turn(policy, "first");
  const first = start(policy, 0);
  turn(policy, "second");
  turn(policy, "third");
  assert.equal(policy.take(40_000).kind, "idle");
  assert.equal(policy.complete(first, true), true);
  const next = start(policy, 40_000);
  assert.equal(next.input, "third");
  assert.equal(first.input, "first");
  assert.equal(policy.complete(first, true), false);
  assert.equal(policy.take(80_000).kind, "idle");
});

test("empty/unchanged input is skipped; failures cannot cause a retry loop", () => {
  const policy = new VocabularyRefresh();
  turn(policy, "  ");
  assert.equal(policy.take(0).kind, "idle");
  policy.settled("first");
  policy.complete(start(policy, 0), true);
  turn(policy, "first");
  turn(policy, "first");
  assert.equal(policy.take(40_000).kind, "idle");
  policy.settled("changed");
  assert.equal(policy.complete(start(policy, 40_000), false), false);
  assert.equal(policy.take(80_000).kind, "idle");
  turn(policy, "new context");
  assert.equal(start(policy, 80_000).input, "new context");
});

test("branch reset rejects stale results without allowing overlapping requests", () => {
  const policy = new VocabularyRefresh();
  turn(policy, "old branch");
  const old = start(policy, 0);
  policy.reset();
  turn(policy, "new branch");
  assert.equal(policy.take(10_000).kind, "idle");
  assert.equal(policy.complete(old, true), false);
  assert.deepEqual(policy.take(10_000), { kind: "wait", delayMs: 20_000 });
  const fresh = start(policy, 30_000);
  assert.equal(fresh.input, "new branch");
  assert.equal(policy.complete(fresh, true), true);
});
