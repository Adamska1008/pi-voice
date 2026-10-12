import { formatBinarySize, LANGUAGE_DETECTION_MODEL, type CatalogModel } from "./catalog.js";
import { requiresLanguageDetector } from "./language-detection-policy.js";
import { findCachedCatalogModel, findIncompleteDownload } from "./models.js";

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
