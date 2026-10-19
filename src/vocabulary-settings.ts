export type VocabularySettings = {
  cacheCapacity: number;
  recordingLimit: number;
  extractionLimit: number;
};

export const DEFAULT_VOCABULARY_SETTINGS: Readonly<VocabularySettings> = Object.freeze({
  cacheCapacity: 128,
  recordingLimit: 64,
  extractionLimit: 64,
});

/** Safety bounds, not user defaults; the merged ASR vocabulary is independently bounded. */
export const MAX_VOCABULARY_CACHE_CAPACITY = 1024;
export const MAX_VOCABULARY_HINT_LIMIT = 128;

export function parseVocabularySettings(value: unknown): { settings: VocabularySettings; warning?: string } {
  const defaults = () => ({ ...DEFAULT_VOCABULARY_SETTINGS });
  const invalid = () => ({
    settings: defaults(),
    warning: "Invalid vocabulary settings; using defaults. Expected cacheCapacity 1–1024, "
      + "recordingLimit/extractionLimit 1–128, both no greater than cacheCapacity (integers).",
  });
  if (value === undefined) return { settings: defaults() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const source = value as Record<string, unknown>;
  // Catch misspellings rather than silently accepting an ineffective configuration.
  if (Object.keys(source).some(key => !Object.hasOwn(DEFAULT_VOCABULARY_SETTINGS, key))) return invalid();
  const settings = defaults();
  for (const key of Object.keys(settings) as (keyof VocabularySettings)[]) {
    if (source[key] === undefined) continue;
    const item = source[key];
    const max = key === "cacheCapacity" ? MAX_VOCABULARY_CACHE_CAPACITY : MAX_VOCABULARY_HINT_LIMIT;
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > max) return invalid();
    settings[key] = item;
  }
  if (settings.recordingLimit > settings.cacheCapacity || settings.extractionLimit > settings.cacheCapacity) return invalid();
  return { settings };
}
