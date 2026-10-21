import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export class ExtractionFailure extends Error {}
type ExtractionStream = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>["streamSimple"];

/** One bounded request; callers own prompting, scheduling, timeouts and persistence. */
export async function requestVocabulary(
  ctx: ExtensionContext, input: string, signal: AbortSignal, instructions: string,
): Promise<string[]> {
  const model = ctx.model;
  if (!model) throw new ExtractionFailure("no-model");
  signal.throwIfAborted();
  const requestId = randomUUID();
  const sessionId = ctx.sessionManager.getSessionId();
  const started = performance.now();
  let usage: unknown;
  let status = "error";
  try {
    const result = await runExtraction(ctx, model, input, signal, requestId, instructions, value => { usage = value; });
    status = "success";
    return result;
  } finally {
    const source = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
    const tokens = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => {
      const value = source[key];
      return [key, typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null];
    }));
    log.info(`voice vocabulary usage: ${JSON.stringify({
      sessionId, requestId, provider: model.provider, model: model.id,
      status: signal.aborted ? "cancelled" : status, elapsedMs: Math.round(performance.now() - started),
      usageStatus: Object.values(tokens).every(value => value !== null) ? "reported" : "unknown-or-partial",
      tokens,
    })}`);
  }
}

async function runExtraction(
  ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, input: string,
  signal: AbortSignal, requestId: string, instructions: string, onUsage: (usage: unknown) => void,
): Promise<string[]> {
  const context: Parameters<ExtractionStream>[1] = {
    systemPrompt: instructions,
    messages: [{ role: "user", content: input, timestamp: Date.now() }],
  };
  const options: NonNullable<Parameters<ExtractionStream>[2]> = {
    signal,
    maxTokens: 512, maxRetries: 0, cacheRetention: "none", sessionId: requestId,
  };
  // The registry owns normalization and authentication; retain compatibility with older Pi.
  const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { streamSimple?: ExtractionStream };
  let stream: ReturnType<ExtractionStream>;
  if (typeof registry.streamSimple === "function") {
    log.info("voice vocabulary request: dispatching via model registry");
    stream = registry.streamSimple(model, context, options);
  } else {
    const provider = registry.getProvider(model.provider);
    if (!provider) throw new ExtractionFailure("no-model");
    const auth = await registry.getApiKeyAndHeaders(model);
    signal.throwIfAborted();
    if (!auth.ok) throw new ExtractionFailure("authentication-unavailable");
    log.info("voice vocabulary request: dispatching via legacy provider");
    stream = provider.streamSimple(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers, env: auth.env });
  }
  const response = await stream.result();
  onUsage(response.usage);
  signal.throwIfAborted();
  if (response.stopReason !== "stop") {
    const reason = ["length", "error", "aborted", "toolUse"].includes(response.stopReason) ? response.stopReason : "unknown";
    throw new ExtractionFailure(`incomplete-${reason}`);
  }
  const text = response.content.filter(part => part.type === "text").map(part => part.text).join("");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ExtractionFailure("invalid-json"); }
  if (!Array.isArray(parsed) || !parsed.every(term => typeof term === "string")) {
    throw new ExtractionFailure("invalid-format");
  }
  return [...new Set<string>(parsed)].filter(term => term.length >= 2 && term.length <= 128
    && term.trim() === term && !/[\r\n]/.test(term) && input.includes(term)).slice(0, 64);
}
