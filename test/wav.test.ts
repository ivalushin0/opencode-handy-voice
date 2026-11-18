import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SECONDS, SAMPLE_RATE, assertWav, encodeWav } from "../src/wav.ts";

test("encodes 16 kHz mono 16-bit PCM and clamps samples", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
  const view = new DataView(wav.buffer);
  const text = (offset: number) => new TextDecoder().decode(wav.slice(offset, offset + 4));

  assert.equal(wav.length, 44 + 8);
  assert.equal(text(0), "RIFF");
  assert.equal(text(8), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)),
    [0, 32767, -32768, 32767],
  );
});

test("accepts only encoded WAVs within the length limit", () => {
  assertWav(encodeWav(new Float32Array(SAMPLE_RATE)));
  assert.throws(() => assertWav(new Uint8Array(100)), /Invalid WAV/);
  assert.throws(() => assertWav(encodeWav(new Float32Array(4), 44100)), /Invalid WAV/);
  const truncated = encodeWav(new Float32Array(4)).subarray(0, 48);
  assert.throws(() => assertWav(truncated), /Invalid WAV/);
  const long = encodeWav(new Float32Array((MAX_SECONDS + 60) * SAMPLE_RATE));
  assert.throws(() => assertWav(long), /Recording too long/);
});
