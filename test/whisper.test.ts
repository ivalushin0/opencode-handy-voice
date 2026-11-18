import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { DEFAULT_MODEL, resolveLanguage, resolveModel } from "../src/settings.ts";
import { formatSize, parseWhisperOutput, writeVerified } from "../src/whisper.ts";

test("strips whisper annotations and collapses whitespace", () => {
  assert.equal(
    parseWhisperOutput(" [BLANK_AUDIO]\n Hello (music) world.\n  Next line.\n"),
    "Hello world. Next line.",
  );
});

test("resolves the model option", () => {
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  assert.equal(resolveModel("large-v3-q5_0"), "large-v3-q5_0");
  assert.throws(() => resolveModel("../etc"), /Invalid model name/);
  assert.throws(() => resolveModel(42), /Invalid model name/);
});

test("resolves the language option", () => {
  assert.equal(resolveLanguage(undefined), "en");
  assert.equal(resolveLanguage("auto"), "auto");
  assert.equal(resolveLanguage("yue"), "yue");
  assert.throws(() => resolveLanguage("-m"), /Invalid language/);
  assert.throws(() => resolveLanguage("French"), /Invalid language/);
});

test("writes a download only when its size and sha256 match", async () => {
  const data = Buffer.from("model bytes");
  const expected = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dictation-test-")), "model.bin");

  await writeVerified(Readable.from([data]), file, expected);
  assert.deepEqual(fs.readFileSync(file), data);

  const tampered = Buffer.from("model bytez");
  await assert.rejects(writeVerified(Readable.from([tampered]), file, expected), /integrity/);
  const longer = Buffer.concat([data, data]);
  await assert.rejects(writeVerified(Readable.from([longer]), file, expected), /larger/);
});

test("formats model sizes", () => {
  assert.equal(formatSize(574_041_195), "574 MB");
  assert.equal(formatSize(1_624_555_275), "1.6 GB");
});
