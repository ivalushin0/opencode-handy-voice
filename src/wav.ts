export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 600;
const HEADER_BYTES = 44;
// Slack for decoder padding past the recording limit.
const MAX_BYTES = HEADER_BYTES + (MAX_SECONDS + 10) * SAMPLE_RATE * 2;

// Accepts only what encodeWav writes, so whisper-cli never parses anything else.
export function assertWav(bytes: Uint8Array) {
  if (bytes.length > MAX_BYTES) throw new Error(`Recording too long (max ${MAX_SECONDS / 60} min)`);
  if (bytes.length < HEADER_BYTES) throw new Error("Invalid WAV");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const valid =
    ascii(0) === "RIFF" &&
    ascii(8) === "WAVE" &&
    ascii(12) === "fmt " &&
    ascii(36) === "data" &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === SAMPLE_RATE &&
    view.getUint16(34, true) === 16 &&
    view.getUint32(40, true) === bytes.length - HEADER_BYTES;
  if (!valid) throw new Error("Invalid WAV");
}

// 16-bit PCM mono WAV, the input whisper.cpp expects.
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return bytes;
}
