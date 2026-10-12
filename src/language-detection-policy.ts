import type { LangIdResult } from "transcribe-cpp";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { displayLanguage, getCatalogModel, languageIdentity, resolveModelLanguage } from "./catalog.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";

/** Only catalog facts are needed; this module never loads a native backend. */
type LanguageModel = {
  readonly languages: readonly string[];
  readonly capabilities: { readonly languageDetection: boolean };
};

export type DetectPolicy = { kind: "detect"; languages: string[]; allowed: string[] };
export type AutoLanguagePolicy =
  | { kind: "native" }
  | { kind: "fixed"; language: string }
  | DetectPolicy
  | { kind: "unsupported"; reason: string };

// Exact labels from transcribe.cpp/catalog/lang-id-voxlingua107-ecapa.json.
// In particular, Cantonese is not a Mandarin alias and Irish is not supported.
export const DETECTOR_LANGUAGES = [
  "ab", "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br",
  "bs", "ca", "ceb", "cs", "cy", "da", "de", "el", "en", "eo", "es", "et",
  "eu", "fa", "fi", "fo", "fr", "gl", "gn", "gu", "gv", "ha", "haw", "hi",
  "hr", "ht", "hu", "hy", "ia", "id", "is", "it", "iw", "ja", "jw", "ka",
  "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi",
  "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no", "oc",
  "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sco", "sd", "si", "sk", "sl",
  "sn", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk",
  "tl", "tr", "tt", "uk", "ur", "uz", "vi", "war", "yi", "yo", "zh",
] as const;

const detectorCodes = new Map<string, string>(
  DETECTOR_LANGUAGES.map((code) => [languageIdentity(code), code]),
);

/** Return the detector's own label (iw/jw/tl/no included). */
export function detectorLanguageCode(language: string): string | undefined {
  return detectorCodes.get(languageIdentity(language));
}

/** Whether this ASR model needs the external detector for Auto, independent of preferences. */
export function requiresLanguageDetector(model: LanguageModel): boolean {
  return !model.capabilities.languageDetection &&
    new Set(model.languages.map(languageIdentity)).size > 1;
}

/** Resolve Auto strictly: never silently drop a compatible but undetectable language. */
export function autoLanguagePolicy(
  model: LanguageModel,
  preferred: readonly string[],
): AutoLanguagePolicy {
  // Native detection retains its existing unrestricted semantics.
  if (model.capabilities.languageDetection) return { kind: "native" };

  const byIdentity = new Map<string, string>();
  for (const preference of preferred) {
    const language = resolveModelLanguage(model, preference);
    if (language !== undefined && !byIdentity.has(languageIdentity(language))) {
      byIdentity.set(languageIdentity(language), language);
    }
  }
  const languages = [...byIdentity.values()];

  if (languages.length === 0) {
    return {
      kind: "unsupported",
      reason: "Auto is unavailable because none of your preferred languages are supported by this model. Choose a transcription language manually or choose a different model.",
    };
  }
  // No detector is needed for a single compatible identity, even Irish/Cantonese.
  if (languages.length === 1) return { kind: "fixed", language: languages[0]! };

  const unsupported = languages.filter((language) => detectorLanguageCode(language) === undefined);
  if (unsupported.length > 0) {
    return {
      kind: "unsupported",
      reason: `Auto language detection does not support ${unsupported.map(displayLanguage).join(", ")}. Choose a transcription language manually or choose a different model.`,
    };
  }
  return { kind: "detect", languages, allowed: languages.map((language) => detectorLanguageCode(language)!) };
}

/** The policy a take runs with: an explicit language is fixed. */
export function settingsLanguagePolicy(settings: TranscribeSettings): AutoLanguagePolicy {
  if (settings.transcriptionLanguage !== "auto") {
    return { kind: "fixed", language: settings.transcriptionLanguage };
  }
  const model = getCatalogModel(settings.model.id);
  // Test/injected backends may use noncatalog ids. Persisted settings never do.
  return model ? autoLanguagePolicy(model, settings.preferredLanguages) : { kind: "native" };
}

const WINDOW_SAMPLES = 7 * CAPTURE_SAMPLE_RATE;
const MIN_SAMPLES = CAPTURE_SAMPLE_RATE / 2;
// Conservative initial operating points, not calibrated probabilities. The
// allowed-set softmax alone can be very confident on out-of-set audio.
const CONFIDENCE = { probability: 0.6, allowedMass: 0.5, margin: 0.15 } as const;

/**
 * Pick one language for a whole clip from its first seven seconds. Low
 * confidence or detector failure falls back to the first preferred language.
 */
export async function detectLanguage(
  policy: DetectPolicy,
  pcm: Float32Array,
  identify: (pcm: Float32Array, allowed: readonly string[]) => Promise<LangIdResult>,
): Promise<{ language: string; warning?: string }> {
  const warnings: string[] = [];
  if (pcm.length < MIN_SAMPLES) {
    warnings.push("Audio is shorter than 500 ms; language detection was skipped.");
  } else {
    if (pcm.length <= CAPTURE_SAMPLE_RATE) {
      warnings.push("Language detection may be unreliable for recordings of 1 second or less.");
    }
    try {
      const result = await identify(pcm.subarray(0, WINDOW_SAMPLES), policy.allowed);
      const [winner, second] = result.candidates;
      const language = policy.languages[policy.allowed.indexOf(result.code ?? "")];
      if (
        language && winner &&
        winner.p >= CONFIDENCE.probability &&
        result.allowedMass >= CONFIDENCE.allowedMass &&
        winner.p - (second?.p ?? 0) >= CONFIDENCE.margin
      ) {
        return { language, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
      }
      warnings.push("Language detection confidence was low.");
    } catch (error) {
      log.warn(`Language detection failed: ${describeError(error)}`);
      warnings.push(`Language detection failed: ${describeError(error)}`);
    }
  }
  const fallback = policy.languages[0]!;
  warnings.push(`Used ${displayLanguage(fallback)} (${fallback}), the first compatible preferred language.`);
  return { language: fallback, warning: warnings.join(" ") };
}
