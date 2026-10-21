import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ReplyRunner = (ctx: ExtensionContext, signal: AbortSignal) => Promise<void>;
async function runReply(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
  const executable = process.env.PI_VOICE_TTS_EXECUTABLE;
  const talkerPath = process.env.PI_VOICE_TTS_TALKER;
  const codecPath = process.env.PI_VOICE_TTS_CODEC;
  if (!executable || !talkerPath || !codecPath) throw new Error("Configure PI_VOICE_TTS_EXECUTABLE, PI_VOICE_TTS_TALKER and PI_VOICE_TTS_CODEC first.");
  const [{ generateSpokenSummary }, { QwenSpeechBackend }, { SpeechPlayer }] = await Promise.all([
    import("./spoken-summary.js"), import("./qwen-tts.js"), import("./speech-player.js"),
  ]);
  signal.throwIfAborted();
  ctx.ui.setStatus("pi-voice-reply", "Generating spoken summary…");
  const summary = await generateSpokenSummary(ctx, signal);
  signal.throwIfAborted();
  if (!summary) { ctx.ui.notify("No completed assistant reply to summarize.", "info"); return; }
  ctx.ui.setStatus("pi-voice-reply", "Synthesizing speech…");
  const audio = await new QwenSpeechBackend({ executable, talkerPath, codecPath,
    device: process.env.PI_VOICE_TTS_DEVICE }).synthesize({ text: summary, signal });
  signal.throwIfAborted();
  ctx.ui.setStatus("pi-voice-reply", "Playing spoken summary…");
  await new SpeechPlayer({ executable: process.env.PI_VOICE_FFPLAY_PATH }).play(audio, signal);
}

/** One manual reply at a time. Repeating the action cancels rather than queues. */
export function createSpeechReply(run: ReplyRunner = runReply) {
  let active: { controller: AbortController; task: Promise<void> } | undefined;
  let closed = false;
  async function stop(): Promise<void> {
    const current = active;
    current?.controller.abort();
    await current?.task;
  }
  return {
    toggle(ctx: ExtensionContext): void {
      if (closed) return;
      if (active) { void stop(); return; }
      if (!ctx.hasUI || !ctx.isIdle()) { ctx.ui.notify("Wait for the assistant to finish before requesting speech.", "info"); return; }
      const controller = new AbortController();
      const current = { controller, task: Promise.resolve() };
      active = current;
      current.task = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return run(ctx, controller.signal);
      }).catch(error => {
        if (!controller.signal.aborted && !closed) {
          ctx.ui.notify(`Spoken reply failed: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
        }
      }).finally(() => {
        if (active === current) {
          active = undefined;
          if (!closed) ctx.ui.setStatus("pi-voice-reply", undefined);
        }
      }).catch(() => undefined); // UI teardown must not cause an unhandled background rejection.
    },
    stop,
    async shutdown(): Promise<void> { closed = true; await stop(); },
  };
}
