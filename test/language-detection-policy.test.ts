import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG_MODELS, getCatalogModel, type CatalogModel } from "../src/catalog.js";
import {
  autoLanguagePolicy,
  DETECTOR_LANGUAGES,
  detectorLanguageCode,
  requiresLanguageDetector,
} from "../src/language-detection-policy.js";
import { settingsForModel, transcriptionLanguageForModel } from "../src/settings.js";

function model(languages: readonly string[], native = false): CatalogModel {
  return {
    ...getCatalogModel("canary-180m-flash")!,
    languages,
    capabilities: { streaming: false, translate: false, languageDetection: native },
  };
}

test("detector mapping lists 107 unique labels and resolves only real aliases and regions", () => {
  // transcribe.cpp's VoxLingua107 catalog, not ASR coverage.
  assert.equal(DETECTOR_LANGUAGES.length, 107);
  assert.equal(new Set(DETECTOR_LANGUAGES).size, 107);
  for (const label of ["ab", "haw", "sco", "war", "zh"]) {
    assert.equal(detectorLanguageCode(label), label);
  }
  for (const unsupported of ["ga", "yue", "zz", "", "auto"]) {
    assert.equal(detectorLanguageCode(unsupported), undefined);
  }
  assert.equal(detectorLanguageCode(" FIL-ph "), "tl");
  assert.equal(detectorLanguageCode("nb-NO"), "no");
  assert.equal(detectorLanguageCode("he-IL"), "iw");
  assert.equal(detectorLanguageCode("jv"), "jw");
  assert.equal(detectorLanguageCode("zh-HK"), "zh");
  assert.equal(detectorLanguageCode("nn"), "nn");
});

test("manual multilingual catalog models miss only Irish and Cantonese detection", () => {
  const languages = [...new Set(CATALOG_MODELS.filter(requiresLanguageDetector)
    .flatMap((entry) => entry.languages))];
  assert.deepEqual(languages.filter((language) => !detectorLanguageCode(language)).sort(), ["ga", "yue"]);
  for (const entry of CATALOG_MODELS.filter(requiresLanguageDetector)) {
    const safe = entry.languages.filter((language) => detectorLanguageCode(language));
    const policy = autoLanguagePolicy(entry, safe);
    assert.equal(policy.kind, "detect", entry.id);
    if (policy.kind === "detect") {
      assert.deepEqual(policy.languages, safe);
      assert.deepEqual(policy.allowed, safe.map(detectorLanguageCode));
    }
  }
});

test("detector requirement is model-wide and deduplicates regions and all aliases", () => {
  assert.equal(requiresLanguageDetector(model(["en", "de"])), true);
  assert.equal(requiresLanguageDetector(model(["ga", "yue"])), true);
  assert.equal(requiresLanguageDetector(model(["en", "de"], true)), false);
  for (const languages of [[], ["en"], ["en-US", "en-GB"], ["tl", "fil"],
    ["no", "nb"], ["he", "iw"], ["jv", "jw"]]) {
    assert.equal(requiresLanguageDetector(model(languages)), false, languages.join(","));
  }
});

test("native Auto is unchanged even for unsupported or empty preferences", () => {
  const native = model(["en", "ga", "yue"], true);
  for (const preferences of [[], ["zz"], ["ga", "yue"], ["yue", "en"]]) {
    assert.deepEqual(autoLanguagePolicy(native, preferences), { kind: "native" });
    assert.equal(transcriptionLanguageForModel("auto", native, preferences), "auto");
    assert.equal(transcriptionLanguageForModel(undefined, native, preferences), "auto");
  }
});

test("compatible preferences retain ordering and exact regional ASR codes", () => {
  const asr = model(["en-US", "en-GB", "es-ES", "es-US", "de-DE"]);
  const preferences = Object.freeze(["zz", " ES-us ", "en-GB", "es-ES", "en", "de"]);
  const before = [...preferences];
  assert.deepEqual(autoLanguagePolicy(asr, preferences), {
    kind: "detect",
    languages: ["es-US", "en-GB", "de-DE"],
    allowed: ["es", "en", "de"],
  });
  assert.deepEqual(preferences, before);
});

test("aliases deduplicate while detector labels and exact ASR codes remain distinct", () => {
  assert.deepEqual(autoLanguagePolicy(model(["fil", "nb-NO", "he", "jv"]),
    ["tl", "fil", "no", "nb", "iw", "he", "jw", "jv"]), {
    kind: "detect", languages: ["fil", "nb-NO", "he", "jv"],
    allowed: ["tl", "no", "iw", "jw"],
  });
  assert.deepEqual(autoLanguagePolicy(model(["tl", "no", "iw", "jw"]),
    ["fil", "nb", "he", "jv"]), {
    kind: "detect", languages: ["tl", "no", "iw", "jw"],
    allowed: ["tl", "no", "iw", "jw"],
  });
  assert.deepEqual(autoLanguagePolicy(model(["he", "iw", "en"]), ["iw", "he", "en"]), {
    kind: "detect", languages: ["iw", "en"], allowed: ["iw", "en"],
  });
});

test("one compatible identity is fixed even if Irish or Cantonese cannot be detected", () => {
  for (const language of ["yue", "ga", "en", "iw", "jw"]) {
    const asr = model([language, "de"]);
    assert.deepEqual(autoLanguagePolicy(asr, ["zz", language, language]), {
      kind: "fixed", language,
    });
    assert.equal(transcriptionLanguageForModel("auto", asr, [language]), "auto");
  }
  assert.deepEqual(autoLanguagePolicy(model(["en-US", "en-GB"]), ["en-GB", "en-US"]), {
    kind: "fixed", language: "en-GB",
  });
});

test("no compatible preferences is unsupported, never an unrestricted detector call", () => {
  for (const preferences of [[], ["fr", "zz"], ["yue"]]) {
    const policy = autoLanguagePolicy(model(["en", "de"]), preferences);
    assert.equal(policy.kind, "unsupported");
    if (policy.kind === "unsupported") {
      assert.match(policy.reason, /none of your preferred languages/);
      assert.match(policy.reason, /manually/);
      assert.match(policy.reason, /different model/);
    }
  }
  assert.equal(autoLanguagePolicy(model([]), ["en"]).kind, "unsupported");
});

test("mixed compatible languages cannot silently drop unsupported detector labels", () => {
  for (const preferences of [["en", "yue"], ["ga", "en"], ["ga", "yue", "en"]]) {
    const policy = autoLanguagePolicy(model(["en", "ga", "yue"]), preferences);
    assert.equal(policy.kind, "unsupported");
    if (policy.kind === "unsupported") {
      if (preferences.includes("ga")) assert.match(policy.reason, /Irish/);
      if (preferences.includes("yue")) assert.match(policy.reason, /Cantonese/);
      assert.match(policy.reason, /manually/);
      assert.match(policy.reason, /different model/);
    }
  }
  // An ASR-incompatible preference is filtered, unlike an undetectable compatible one.
  assert.deepEqual(autoLanguagePolicy(model(["en", "de"]), ["yue", "de", "en"]), {
    kind: "detect", languages: ["de", "en"], allowed: ["de", "en"],
  });
});

test("new manual multilingual settings default to Auto when fixed or detect is safe", () => {
  const asr = model(["en", "de", "yue"]);
  assert.equal(transcriptionLanguageForModel(undefined, asr, ["de", "en"]), "auto");
  assert.equal(transcriptionLanguageForModel(undefined, asr, ["yue"]), "auto");
  assert.equal(transcriptionLanguageForModel(undefined, asr, ["en", "yue"]), "en");
  assert.equal(transcriptionLanguageForModel(undefined, asr, ["yue", "en"]), "yue");
  assert.equal(transcriptionLanguageForModel(undefined, asr, []), "en");
});

test("single-identity models default to explicit but preserve valid saved Auto", () => {
  for (const language of ["en", "yue", "ga"]) {
    const asr = model([language]);
    assert.equal(transcriptionLanguageForModel(undefined, asr, [language]), language);
    assert.equal(transcriptionLanguageForModel("auto", asr, [language]), "auto");
  }
  const regional = model(["en-US", "en-GB"]);
  assert.equal(transcriptionLanguageForModel(undefined, regional, ["en-GB"]), "en-GB");
});

test("saved explicit languages survive Auto eligibility and preference changes", () => {
  for (const native of [false, true]) {
    const asr = model(["en-US", "en-GB", "no", "tl", "iw", "jw", "yue"], native);
    assert.equal(transcriptionLanguageForModel("en-GB", asr, ["yue"]), "en-GB");
    assert.equal(transcriptionLanguageForModel("nb", asr, ["en"]), "no");
    assert.equal(transcriptionLanguageForModel("fil", asr, []), "tl");
    assert.equal(transcriptionLanguageForModel("he", asr, []), "iw");
    assert.equal(transcriptionLanguageForModel("jv", asr, []), "jw");
    assert.equal(transcriptionLanguageForModel("yue", asr, ["en"]), "yue");
  }
});

test("new model selection normalizes unsupported Auto safely while strict runtime policy refuses", () => {
  const asr = model(["en", "ga", "yue"]);
  assert.equal(transcriptionLanguageForModel("auto", asr, ["ga", "en"]), "ga");
  assert.equal(transcriptionLanguageForModel("auto", asr, ["zz"]), "en");
  assert.equal(autoLanguagePolicy(asr, ["ga", "en"]).kind, "unsupported");
  assert.equal(transcriptionLanguageForModel("zz", asr, ["en"]), "auto");
});

test("settings creation keeps schema v1, preferences, and explicit choices", () => {
  const preferences = ["en", "de"];
  const automatic = settingsForModel("canary-180m-flash", "/tmp/model", {
    preferredLanguages: preferences,
  });
  assert.equal(automatic.version, 1);
  assert.equal(automatic.transcriptionLanguage, "auto");
  assert.deepEqual(automatic.preferredLanguages, preferences);
  assert.equal(settingsForModel("parakeet-unified-en-0.6b", "/tmp/model").transcriptionLanguage, "en");
  assert.equal(settingsForModel("canary-180m-flash", "/tmp/model", {
    preferredLanguages: preferences, transcriptionLanguage: "fr",
  }).transcriptionLanguage, "fr");
  const unsupported = settingsForModel("Fun-ASR-MLT-Nano-2512", "/tmp/model", {
    preferredLanguages: ["yue", "en"], transcriptionLanguage: "auto",
  });
  assert.equal(unsupported.transcriptionLanguage, "yue");
  assert.deepEqual(unsupported.preferredLanguages, ["yue", "en"]);
});
