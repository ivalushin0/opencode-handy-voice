import assert from "node:assert/strict";
import test from "node:test";

import { check, parseHandyOutput, parseModels, resolveHandyPath } from "../src/handy.ts";
import { isModel, resolveModel } from "../src/settings.ts";

test("parses Handy JSON after log lines", () => {
  const result = parseHandyOutput(
    `[info] loading model\n{"audio_secs":1.5,"best_ms":42,"text":" Привет, мир. "}\n`,
  );
  assert.deepEqual(result, { text: "Привет, мир.", audioSecs: 1.5, ms: 42 });
});

test("rejects output without a Handy JSON object", () => {
  assert.throws(() => parseHandyOutput("[info] no json here"), /no transcription JSON/);
});

test("reports a missing Handy binary instead of throwing", () => {
  const result = check("C:\\definitely\\missing\\handy.exe");
  assert.equal(result.handy, false);
  assert.match(result.error ?? "", /not found/i);
});

test("rejects a non-existent Handy path", () => {
  assert.throws(() => resolveHandyPath("C:\\definitely\\missing\\handy.exe"), /not found/i);
});

test("parses Handy model metadata and puts downloaded models first", () => {
  const models = parseModels(
    JSON.stringify([
      {
        id: "handy-computer/gigaam-v3-e2e-rnnt-gguf/gigaam-v3-e2e-rnnt-Q8_0.gguf",
        name: "GigaAM v3 E2E-RNN-T",
        description: "Best for Russian dictation.",
        size_mb: 261,
        is_downloaded: true,
        is_recommended: false,
        supported_languages: ["ru"],
      },
      {
        id: "small",
        name: "Whisper Small",
        description: "Fast and fairly accurate.",
        size_mb: 465,
        is_downloaded: false,
        is_recommended: true,
        supported_languages: ["ru", "en"],
      },
    ]),
  );
  assert.equal(
    models[0]?.id,
    "handy-computer/gigaam-v3-e2e-rnnt-gguf/gigaam-v3-e2e-rnnt-Q8_0.gguf",
  );
  assert.equal(models[0]?.downloaded, true);
  assert.deepEqual(models[0]?.languages, ["ru"]);
  assert.equal(models[1]?.id, "small");
  assert.equal(models[1]?.recommended, true);
});

test("rejects a malformed Handy model list", () => {
  assert.throws(() => parseModels("not json"), /invalid model JSON/);
  assert.throws(() => parseModels("{}"), /no model list/);
});

test("accepts empty or well-formed model ids", () => {
  assert.equal(resolveModel(undefined), "");
  assert.equal(resolveModel(""), "");
  assert.equal(
    resolveModel("handy-computer/gigaam-v3-e2e-rnnt-gguf/gigaam-v3-e2e-rnnt-Q8_0.gguf"),
    "handy-computer/gigaam-v3-e2e-rnnt-gguf/gigaam-v3-e2e-rnnt-Q8_0.gguf",
  );
  assert.equal(isModel("../escape"), false);
  assert.throws(() => resolveModel("../escape"), /Invalid Handy model id/);
});
