import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { HandsFreeEngine } from "./handsfree-engine.js";
import { openWakeDetector, WAKE_PHRASE, type WakeDetector } from "./wake-detector.js";
import { readDictationVocabulary } from "./vocabulary.js";
import type { Capture } from "./dictation-controller.js";
import type { TranscribeSettings } from "./settings.js";
import type { TranscriptionService } from "./transcription-service.js";
import type { VadScorer, VoiceActivityDetection } from "./vad.js";

const STATUS = "pi-voice-handsfree";
const labels = {
  wake: `免手监听：说“${WAKE_PHRASE}”`, dictation: "免手听写：提示后说话，停顿生成草稿",
  command: "草稿待确认：确认发送 / 取消输入 / 继续", recognizing: "免手转写中（尚未发送）",
  paused: "免手已暂停（麦克风仍开启）：助手忙碌或正在播音", off: "免手关闭",
};
type Dependencies = {
  settings(): Promise<TranscribeSettings>;
  service: TranscriptionService;
  vad: VoiceActivityDetection;
  automaticVocabulary(): readonly string[];
  blocked(): boolean;
  openWake?: typeof openWakeDetector;
  openMicrophone?: typeof import("./audio.js")["openMicrophone"];
};
type Active = { controller: AbortController; ready: Promise<void>; cleanup(): Promise<void>; engine?: HandsFreeEngine };
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener("abort", abort));
}

/** Owns continuous microphone lifetime; neither listening audio nor command audio is saved. */
export function createHandsFreeMode(pi: ExtensionAPI, dependencies: Dependencies) {
  let active: Active | undefined;
  async function stop(): Promise<void> {
    const current = active;
    if (!current) return;
    current.controller.abort();
    await current.ready;
    await current.cleanup();
  }
  return {
    get enabled() { return active !== undefined; },
    pause() { active?.engine?.pause(); },
    stop,
    async command(args: string, ctx: ExtensionContext): Promise<void> {
      const action = args.trim().toLowerCase();
      if (action === "status") { ctx.ui.notify(active ? labels[active.engine?.state.phase ?? "paused"] : labels.off, "info"); return; }
      if (action && !["on", "off"].includes(action)) { ctx.ui.notify("Usage: /voice-handsfree [on|off|status]", "info"); return; }
      if (action === "off" || (!action && active)) { await stop(); return; }
      if (active) { ctx.ui.notify("Hands-free mode is already starting or enabled.", "info"); return; }
      if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("Hands-free mode requires Pi's interactive terminal.", "warning"); return; }
      if (!ctx.isIdle() || dependencies.blocked()) { ctx.ui.notify("Wait until recording, speech and the assistant are idle.", "warning"); return; }
      if (ctx.ui.getEditorText()) { ctx.ui.notify("Clear or send the editor before enabling hands-free mode.", "warning"); return; }
      const controller = new AbortController();
      let capture: Capture | undefined, wake: WakeDetector | undefined, scorer: VadScorer | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined, cleanupPromise: Promise<void> | undefined;
      const current: Active = { controller, ready: Promise.resolve(), cleanup };
      function cleanup(): Promise<void> {
        return cleanupPromise ??= (async () => {
          clearInterval(heartbeat);
          await capture?.stop().catch(() => undefined);
          if (current.engine) await current.engine.stop();
          else { await wake?.close(); scorer?.dispose(); }
          if (active === current) active = undefined;
          try { ctx.ui.setStatus(STATUS, undefined); } catch { /* UI may already be shutting down. */ }
        })();
      }
      const report = (error: unknown) => {
        try { if (!controller.signal.aborted) ctx.ui.notify(`Hands-free stopped: ${error instanceof Error ? error.message : "local audio error"}`, "warning"); }
        finally { void stop().catch(() => undefined); }
      };
      active = current;
      current.ready = (async () => {
        const settings = await dependencies.settings();
        controller.signal.throwIfAborted();
        const approved = await abortable(ctx.ui.confirm("Enable local hands-free listening?",
          `The microphone stays open until /voice-handsfree off. Say “${WAKE_PHRASE}”, wait for the cue, then dictate. `
          + "Silence creates a draft, never sends it. In the confirmation stage say “确认发送”, “取消输入” or “继续”. "
          + "Wake detection and transcription are local; audio is not saved. Sending a confirmed draft invokes your configured assistant. "
          + "Anyone nearby can trigger commands; this is not speaker authentication. Terminal bells may be muted: watch the status line."), controller.signal);
        if (!approved) { controller.abort(); return; }
        controller.signal.throwIfAborted();
        wake = await (dependencies.openWake ?? openWakeDetector)(process.env.PI_VOICE_KWS_MODEL_DIR || join(getAgentDir(), "models", "pi-voice-kws"), controller.signal);
        controller.signal.throwIfAborted();
        scorer = await dependencies.vad.openScorer();
        controller.signal.throwIfAborted();
        current.engine = new HandsFreeEngine({
          wake, scorer,
          transcribe: async (pcm, command, signal) => {
            const vocabulary = command ? [] : (await readDictationVocabulary(ctx.cwd, dependencies.automaticVocabulary)).terms;
            signal.throwIfAborted();
            // Commands deliberately get no conversation/vocabulary hints that could bias an approval.
            const reservation = dependencies.service.reserveDictation(settings, vocabulary);
            const cancel = () => reservation.cancel();
            signal.addEventListener("abort", cancel, { once: true });
            try { signal.throwIfAborted(); return (await reservation.submit(pcm, signal)).text; }
            finally { signal.removeEventListener("abort", cancel); reservation.cancel(); }
          },
          readEditor: () => ctx.ui.getEditorText(), writeEditor: text => ctx.ui.setEditorText(text),
          send: text => {
            if (controller.signal.aborted || !ctx.isIdle() || dependencies.blocked()) throw new Error("Assistant is busy; draft was not submitted.");
            pi.sendUserMessage(text);
          },
          blocked: () => controller.signal.aborted || !ctx.isIdle() || dependencies.blocked(),
          status: (phase, ready) => ctx.ui.setStatus(STATUS, ready === false ? "已唤醒／转写完成：请稍候，提示后再说话…" : labels[phase]),
          cue: () => { if (process.stdout.isTTY) process.stdout.write("\x07"); },
          failure: report,
        });
        const openMicrophone = dependencies.openMicrophone ?? (await import("./audio.js")).openMicrophone;
        controller.signal.throwIfAborted();
        capture = await openMicrophone(settings.microphone, {
          onAudio: frame => { if (!controller.signal.aborted) current.engine?.feed(frame); },
          onFailure: report,
        }, false); // collect:false is essential for unbounded listening duration.
        controller.signal.throwIfAborted();
        heartbeat = setInterval(() => current.engine?.tick(), 250);
        heartbeat.unref();
        current.engine.tick();
      })().catch(error => {
        try { if (!controller.signal.aborted) ctx.ui.notify(`Could not enable hands-free mode: ${error instanceof Error ? error.message : "local audio error"}`, "warning"); }
        finally { controller.abort(); }
      }).finally(async () => { if (controller.signal.aborted) await cleanup(); });
      await current.ready;
    },
  };
}
