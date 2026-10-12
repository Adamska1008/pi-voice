import type { CatalogModel } from "./catalog.js";
import { downloadCatalogModel, findCachedCatalogModel, type CachedCatalogModel } from "./models.js";
import { manualTranscriptionLanguage, writeSettings, type TranscribeSettings } from "./settings.js";
import { LANGUAGE_DETECTION_MODEL, needsLanguageDetectorDownload } from "./language-detection-model.js";

export type ActivationProgress = { downloaded: number; total: number; message?: string };
export type ActivationResult = { path: string; warning?: string };

export type CatalogModelActivation = (
  model: CatalogModel,
  options: {
    cached: CachedCatalogModel | undefined;
    signal: AbortSignal;
    onProgress: (progress: ActivationProgress) => void;
  },
) => Promise<ActivationResult>;

/**
 * The download-then-save pipeline behind the model picker, shared by
 * onboarding and the settings menu. Back-to-back selections can outrun their
 * settings writes; commits run in selection order, so the file always ends on
 * the user's last choice.
 */
export function createModelActivation(options: {
  buildSettings: (model: CatalogModel, path: string) => TranscribeSettings;
  onCommitted: (settings: TranscribeSettings) => void;
  onWarning?: (message: string) => void;
}): {
  activate: CatalogModelActivation;
  /** Resolves once every commit enqueued so far has landed (or failed). */
  waitForCommits: () => Promise<void>;
} {
  let commitQueue: Promise<void> = Promise.resolve();

  const activate: CatalogModelActivation = async (
    model,
    { cached, signal, onProgress },
  ) => {
    let path: string;
    let warning: string | undefined;
    const detectorMissing = needsLanguageDetectorDownload(model);
    const asrBytes = cached ? 0 : model.size;
    const total = asrBytes + (detectorMissing ? LANGUAGE_DETECTION_MODEL.size : 0);
    if (cached) {
      // The picker listed the cache when it opened; re-check so settings
      // never point at a file that has since been evicted. Integrity is
      // covered by the download-time hash and the size check here.
      const stillCached = findCachedCatalogModel(model);
      if (!stillCached) {
        throw new Error(
          "the downloaded file is missing; select the model again to re-download it",
        );
      }
      path = stillCached.path;
    } else {
      path = await downloadCatalogModel(model, {
        signal,
        onProgress: (progress) => onProgress({ ...progress, total }),
      });
    }

    if (detectorMissing) {
      try {
        onProgress({ downloaded: asrBytes, total, message: "Downloading shared language detector…" });
        await downloadCatalogModel(LANGUAGE_DETECTION_MODEL, {
          signal,
          onProgress: (progress) => onProgress({
            downloaded: asrBytes + progress.downloaded, total,
            message: "Downloading shared language detector…",
          }),
        });
      } catch (error) {
        // Cancellation is never a settings commit. Other failures leave the
        // verified ASR in the cache and select a usable manual language.
        signal.throwIfAborted();
        warning = `Language detector download failed: ${error instanceof Error ? error.message : String(error)}. The transcription model is cached; a fixed language is selected. Choose the model again to retry the download, then enable Auto in settings, or keep selecting a transcription language manually.`;
      }
    }

    const commit = commitQueue.then(async () => {
      // Skip the write when this selection was superseded or its download
      // was cancelled while the commit sat in the queue.
      signal.throwIfAborted();
      let settings: TranscribeSettings;
      try {
        settings = options.buildSettings(model, path);
        if (warning && settings.transcriptionLanguage === "auto") {
          settings.transcriptionLanguage = manualTranscriptionLanguage(model, settings.preferredLanguages);
        }
        await writeSettings(settings);
      } catch (error) {
        throw new Error(
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      options.onCommitted(settings);
    });
    commitQueue = commit.then(
      () => undefined,
      () => undefined,
    );
    await commit;
    if (warning) {
      try { options.onWarning?.(warning); } catch { /* Notification is not part of the save. */ }
    }
    return { path, ...(warning ? { warning } : {}) };
  };

  return { activate, waitForCommits: () => commitQueue };
}
