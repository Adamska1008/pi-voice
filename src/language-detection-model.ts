import { formatBinarySize, type CatalogModel } from "./catalog.js";
import { DETECTOR_LANGUAGES, requiresLanguageDetector } from "./language-detection-policy.js";
import { findCachedCatalogModel, findIncompleteDownload } from "./models.js";

/** Companion only, deliberately not part of the ASR catalog. Metadata pinned
 * from the public Hugging Face model API (including LFS SHA-256). */
export const LANGUAGE_DETECTION_MODEL: CatalogModel = {
  id: "voxlingua107-ecapa-q8",
  name: "VoxLingua107 language detector",
  description: "Shared spoken-language detector for multilingual transcription models",
  repository: "handy-computer/lang-id-voxlingua107-ecapa-gguf",
  revision: "41cf26039e317c6b8883bf0a61b0785dc663fc26",
  license: "apache-2.0",
  family: "ECAPA-TDNN",
  parameters: null,
  languages: DETECTOR_LANGUAGES,
  capabilities: { streaming: false, translate: false, languageDetection: true },
  quant: "Q8_0",
  filename: "lang-id-voxlingua107-ecapa-Q8_0.gguf",
  size: 26693632,
  sha256: "063e6cb0af3d53085fc7d68356dfde5ecee2ffa7bc79855f7e4ff930081bfe3a",
};

export function findCachedLanguageDetector() {
  return findCachedCatalogModel(LANGUAGE_DETECTION_MODEL);
}

export function needsLanguageDetectorDownload(model: CatalogModel): boolean {
  return requiresLanguageDetector(model) && !findCachedLanguageDetector();
}

/** Remaining network bytes, excluding cached files and resumable prefixes. */
export function remainingModelDownloadBytes(model: CatalogModel, asrCached = Boolean(findCachedCatalogModel(model))): number {
  const remaining = (item: CatalogModel) => item.size - (findIncompleteDownload(item)?.bytes ?? 0);
  return (asrCached ? 0 : remaining(model)) +
    (needsLanguageDetectorDownload(model) ? remaining(LANGUAGE_DETECTION_MODEL) : 0);
}

/** Shown before the single bundled download action, never once cached. */
export function languageDetectorDownloadNote(model: CatalogModel): string | undefined {
  return needsLanguageDetectorDownload(model)
    ? `Includes the shared VoxLingua107 language detector (${formatBinarySize(LANGUAGE_DETECTION_MODEL.size)}, Q8) for automatic language selection.`
    : undefined;
}

export function modelDownloadAction(model: CatalogModel, asrCached: boolean): string {
  if (asrCached && !needsLanguageDetectorDownload(model)) return "choose";
  const resuming = (!asrCached && findIncompleteDownload(model)) ||
    (needsLanguageDetectorDownload(model) && findIncompleteDownload(LANGUAGE_DETECTION_MODEL));
  return `${resuming ? "resume" : "download"} ${formatBinarySize(remainingModelDownloadBytes(model, asrCached))}`;
}
