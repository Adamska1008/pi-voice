import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectVocabularyDocuments } from "./vocabulary-documents.js";
import { extractProjectVocabulary } from "./vocabulary-project.js";

export type InitializationResult = "saved" | "exists" | "skipped" | "cancelled" | "failed";
const defaults = { collect: collectVocabularyDocuments, extract: extractProjectVocabulary, publish: link, timeoutMs: 30_000 };

/** Session-scoped coordinator. Caller must obtain consent before start; shutdown is terminal. */
export function createVocabularyInitializer(dependencies: Partial<typeof defaults> = {}) {
  const { collect, extract, publish, timeoutMs } = { ...defaults, ...dependencies };
  const tasks = new Map<string, Promise<InitializationResult>>();
  const attempts = new Map<string, Promise<InitializationResult>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  async function initialize(ctx: ExtensionContext, root: string, signal: AbortSignal, beginSaving: () => void): Promise<InitializationResult> {
    const directory = join(root, ".pi");
    const destination = join(directory, "voice-vocabulary.json");
    const checkDirectory = async () => {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe project configuration directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    await checkDirectory();
    try { await lstat(destination); return "exists"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    signal.throwIfAborted();
    const collection = await collect(root);
    signal.throwIfAborted();
    if (!collection.documents.some(document => document.text.trim())) return "skipped";
    const terms = await extract(ctx, collection.documents, signal);
    signal.throwIfAborted();
    // Once filesystem mutation begins, cancellation must drain publication/cleanup.
    beginSaving();
    await mkdir(directory, { recursive: true });
    await checkDirectory();
    const temporary = join(directory, `.voice-vocabulary-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ terms }, null, 2) + "\n", { flag: "wx" });
      signal.throwIfAborted();
      // Publish a complete file atomically without replacing an existing destination.
      // No overwrite-prone rename fallback if the filesystem cannot create hard links.
      try { await publish(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw error;
      }
      return "saved";
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async function startOnce(ctx: ExtensionContext, requested: string): Promise<InitializationResult> {
      if (closed) return "cancelled";
      let root: string;
      try { root = await realpath(requested); } catch { return "failed"; }
      if (closed) return "cancelled";
      const existing = tasks.get(root);
      if (existing) return existing; // Retain failures too: no automatic retries this session.
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      let saving = false;
      let onAbort!: () => void;
      const cancelled = new Promise<InitializationResult>(resolve => {
        onAbort = () => { if (!saving) resolve("cancelled"); };
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const work = initialize(ctx, root, controller.signal, () => { saving = true; })
        .catch((error): InitializationResult => error === controller.signal.reason ? "cancelled" : "failed");
      const task = Promise.race([work, cancelled]).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        controllers.delete(controller);
      });
      tasks.set(root, task);
      return task;
  }
  return {
    start(ctx: ExtensionContext): Promise<InitializationResult> {
      if (closed) return Promise.resolve("cancelled");
      const requested = resolve(ctx.cwd);
      const existing = attempts.get(requested);
      if (existing) return existing;
      const task = startOnce(ctx, requested);
      attempts.set(requested, task);
      return task;
    },
    async shutdown(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(attempts.values());
    },
  };
}
