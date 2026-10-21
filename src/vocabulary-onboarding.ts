import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createVocabularyInitializer } from "./vocabulary-init.js";

/** Consent is per project/session; no document contents leave the machine before approval. */
export function createVocabularyOnboarding(initializer = createVocabularyInitializer()) {
  const attempted = new Set<string>();
  let closed = false;
  return {
    async prepare(ctx: ExtensionContext): Promise<() => void> {
      const noop = () => {};
      const root = resolve(ctx.cwd);
      if (closed || !ctx.hasUI || !ctx.model || attempted.has(root)) return noop;
      attempted.add(root);
      try {
        await lstat(join(root, ".pi", "voice-vocabulary.json"));
        return noop; // Invalid or empty files are still owned by the user.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return noop;
      }
      if (closed) return noop;
      try {
        const approved = await ctx.ui.confirm("Initialize project voice vocabulary?",
          `Send README.md and up to 8 local Markdown documents discovered from its links to ${ctx.model.provider}/${ctx.model.id}? `
          + "The simple link parser may include links in truncated code examples. "
          + "This creates .pi/voice-vocabulary.json without replacing existing files. "
          + "Recording will not wait for generation. Declining skips initialization for this session.");
        if (!approved || closed) return noop;
      } catch { return noop; }
      let started = false;
      return () => {
        if (closed || started) return;
        started = true;
        void initializer.start(ctx).then(result => {
          if (closed) return;
          if (result === "saved") ctx.ui.notify("Project voice vocabulary initialized; available on your next recording.", "info");
          if (result === "failed") ctx.ui.notify("Project voice vocabulary initialization failed; recording is unaffected.", "warning");
        }).catch(() => undefined); // Background/provider/UI failures must not interrupt recording.
      };
    },
    async shutdown(): Promise<void> {
      closed = true;
      await initializer.shutdown();
    },
  };
}
