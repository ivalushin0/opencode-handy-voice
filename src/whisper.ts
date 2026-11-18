import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_MODEL, MODELS_URL } from "./settings.ts";
import { assertWav } from "./wav.ts";

// Checked even if Hugging Face serves a different file. Other models use the hash Hugging Face reports.
const MODEL_SHA256: Record<string, string> = {
  [DEFAULT_MODEL]: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};
const MAX_MODEL_BYTES = 4e9;

const DOWNLOAD_DIR = path.join(os.homedir(), ".local", "share", "whisper-cpp");
// Also where opencode-voice and the whisper-cpp Homebrew formula keep models.
const MODEL_DIRS = [
  DOWNLOAD_DIR,
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];
// Desktop starts with a minimal PATH that misses Homebrew.
const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const TIMEOUT_MS = 120_000;

const fileName = (model: string) => `ggml-${model}.bin`;
const modelUrl = (model: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName(model)}`;

export function findModel(model: string): string | undefined {
  return MODEL_DIRS.map((dir) => path.join(dir, fileName(model))).find((file) =>
    fs.existsSync(file),
  );
}

const isExecutable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export function findWhisper(): string | undefined {
  const dirs = [...BINARY_DIRS, ...(process.env.PATH ?? "").split(path.delimiter)];
  return dirs
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "whisper-cli"))
    .find(isExecutable);
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// Hugging Face answers with a redirect to its CDN, and reports the file's size and sha256.
async function modelInfo(model: string) {
  const response = await fetch(modelUrl(model), { method: "HEAD", redirect: "manual" });
  if (response.status === 404) throw new Error(`Unknown model "${model}". See ${MODELS_URL}`);
  if (response.status >= 400) throw new Error(`Model lookup failed: HTTP ${response.status}`);
  const sha256 = response.headers.get("x-linked-etag")?.replaceAll('"', "") ?? "";
  const size = Number(response.headers.get("x-linked-size"));
  if (!/^[0-9a-f]{64}$/.test(sha256) || !(size > 0))
    throw new Error("Model lookup failed: no size or checksum");
  if (size > MAX_MODEL_BYTES) throw new Error(`Model too large: ${formatSize(size)}`);
  return { sha256, size };
}

export async function modelSize(model: string): Promise<string> {
  return formatSize((await modelInfo(model)).size);
}

// Writes `source` to `file`, and rejects unless its size and sha256 match.
export async function writeVerified(
  source: AsyncIterable<Uint8Array>,
  file: string,
  expected: { sha256: string; size: number },
) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > expected.size) throw new Error("Model download is larger than expected");
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(file),
  );
  if (bytes !== expected.size || hash.digest("hex") !== expected.sha256)
    throw new Error("Model download failed the integrity check");
}

export async function downloadModel(model: string) {
  const info = await modelInfo(model);
  const sha256 = MODEL_SHA256[model] ?? info.sha256;
  const response = await fetch(modelUrl(model));
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const target = path.join(DOWNLOAD_DIR, fileName(model));
  const partial = `${target}.part`;
  try {
    await writeVerified(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      partial,
      { sha256, size: info.size },
    );
    fs.renameSync(partial, target);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

export function parseWhisperOutput(stdout: string): string {
  return stdout
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribe(
  wav: Uint8Array,
  input: { binary: string; model: string; language: string },
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-dictation-"));
  const file = path.join(dir, "recording.wav");
  try {
    assertWav(wav);
    fs.writeFileSync(file, wav);
    const args = ["-m", input.model, "-f", file, "-l", input.language, "-np", "-nt"];
    const { code, stdout, stderr } = await run(input.binary, args);
    // whisper-cli exits 0 on an unknown language and prints the error instead.
    const languageError = stderr.match(/error: unknown language '([^']+)'/);
    if (languageError) throw new Error(`Unknown whisper language: ${languageError[1]}`);
    if (code !== 0)
      throw new Error(stderr.trim().split("\n").pop() || `whisper-cli exited (${code})`);
    return parseWhisperOutput(stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(binary: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Transcription timed out"));
    }, TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
