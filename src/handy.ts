import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWav } from "./wav.ts";

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

// Called only in the main process, but the module is also evaluated in a window, where `process` is absent.
const isWindows = () => typeof process !== "undefined" && process.platform === "win32";
const isMac = () => typeof process !== "undefined" && process.platform === "darwin";

export type Check = {
  handy: boolean;
  path: string;
  error?: string;
};

export type Transcription = {
  text: string;
  audioSecs: number | null;
  ms: number | null;
};

export type HandyModel = {
  id: string;
  name: string;
  description: string;
  sizeMb: number;
  downloaded: boolean;
  recommended: boolean;
  languages: string[];
};

export type InstallResult = {
  ok: boolean;
  message: string;
  manual?: boolean;
};

const expand = (value: string) => {
  const withHome =
    value === "~" || value.startsWith(`~${path.sep}`) || value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(1))
      : value;
  if (!isWindows()) return withHome;
  return withHome.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? "");
};

const executable = (file: string) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (isWindows()) return file.toLowerCase().endsWith(".exe");
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const candidates = () => {
  if (isWindows()) {
    return [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Handy", "handy.exe"),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Programs", "Handy", "handy.exe"),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Handy", "handy.exe"),
      process.env["PROGRAMFILES(X86)"] &&
        path.join(process.env["PROGRAMFILES(X86)"], "Handy", "handy.exe"),
    ].filter((value): value is string => !!value);
  }
  if (isMac()) {
    return [
      "/Applications/Handy.app/Contents/MacOS/handy",
      path.join(os.homedir(), "Applications/Handy.app/Contents/MacOS/handy"),
    ];
  }
  return ["/usr/bin/handy", "/usr/local/bin/handy", path.join(os.homedir(), ".local/bin/handy")];
};

const findOnPath = (name: string) => {
  const extensions = isWindows() ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const file = path.join(directory, name + extension);
      if (executable(file)) return file;
    }
  }
};

export function resolveHandyPath(value: unknown): string {
  const configured = typeof value === "string" ? value.trim() : "";
  if (configured) {
    const file = expand(configured);
    if (executable(file)) return file;
    // A bare command such as `handy` is looked up on PATH.
    if (!file.includes("/") && !file.includes("\\")) {
      const found = findOnPath(file);
      if (found) return found;
    }
    throw new Error(`Handy not found at "${configured}". Set the path in Settings → Handy Voice.`);
  }
  const found = candidates().find(executable) ?? findOnPath(isWindows() ? "handy.exe" : "handy");
  if (!found) {
    throw new Error(
      "Handy is not installed. Download it from https://handy.computer and set its path in Settings → Handy Voice.",
    );
  }
  return found;
}

export function check(value: unknown): Check {
  try {
    return { handy: true, path: resolveHandyPath(value) };
  } catch (err) {
    return {
      handy: false,
      path: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Handy logs to stderr and prints one JSON object to stdout. Be tolerant of extra lines.
export function parseHandyOutput(stdout: string): Transcription {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as {
        text?: unknown;
        audio_secs?: unknown;
        best_ms?: unknown;
      };
      if (typeof value.text === "string") {
        return {
          text: value.text.trim(),
          audioSecs: typeof value.audio_secs === "number" ? value.audio_secs : null,
          ms: typeof value.best_ms === "number" ? value.best_ms : null,
        };
      }
    } catch {
      // Not the JSON line.
    }
  }
  throw new Error("Handy returned no transcription JSON");
}

export function parseModels(stdout: string): HandyModel[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Handy returned invalid model JSON");
  }
  if (!Array.isArray(value)) throw new Error("Handy returned no model list");

  const models: HandyModel[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    models.push({
      id: record.id,
      name: typeof record.name === "string" && record.name ? record.name : record.id,
      description: typeof record.description === "string" ? record.description : "",
      sizeMb: typeof record.size_mb === "number" ? record.size_mb : 0,
      downloaded: record.is_downloaded === true,
      recommended: record.is_recommended === true,
      languages: Array.isArray(record.supported_languages)
        ? record.supported_languages.filter(
            (language): language is string => typeof language === "string",
          )
        : [],
    });
  }
  return models.sort((left, right) => {
    if (left.downloaded !== right.downloaded) return left.downloaded ? -1 : 1;
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export async function transcribe(
  wav: Uint8Array,
  input: { binary: string; model: string },
): Promise<Transcription> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-handy-voice-"));
  const file = path.join(directory, "recording.wav");
  try {
    assertWav(wav);
    fs.writeFileSync(file, wav);
    const args = ["--transcribe-file", file, "--json"];
    if (input.model) args.push("--model", input.model);
    const { code, stdout, stderr } = await run(input.binary, args, TRANSCRIBE_TIMEOUT_MS, "Handy");
    if (code !== 0) throw commandError("Handy", code, stderr);
    return parseHandyOutput(stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function listModels(binary: string): Promise<HandyModel[]> {
  const { code, stdout, stderr } = await run(
    binary,
    ["--list-models", "--json"],
    COMMAND_TIMEOUT_MS,
    "Handy model list",
  );
  if (code !== 0) throw commandError("Handy", code, stderr);
  return parseModels(stdout);
}

export function openApp(binary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function install(): Promise<InstallResult> {
  if (isWindows()) {
    const winget = findOnPath("winget");
    if (!winget) {
      return {
        ok: false,
        manual: true,
        message: "winget не найден. Установите Handy вручную.",
      };
    }
    const { code, stdout, stderr } = await run(
      winget,
      [
        "install",
        "--id",
        "cjpais.Handy",
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
      ],
      INSTALL_TIMEOUT_MS,
      "winget",
    );
    if (code === 0) {
      return { ok: true, message: "Handy установлен. Проверьте путь и выберите модель." };
    }
    const detail = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    return {
      ok: false,
      message: detail ? `winget: ${detail}` : "winget не смог установить Handy.",
    };
  }

  if (isMac()) {
    const brew = findOnPath("brew");
    if (brew) {
      const { code, stdout, stderr } = await run(
        brew,
        ["install", "--cask", "handy"],
        INSTALL_TIMEOUT_MS,
        "Homebrew",
      );
      if (code === 0) {
        return { ok: true, message: "Handy установлен через Homebrew." };
      }
      const detail = (stderr || stdout).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
      return {
        ok: false,
        manual: true,
        message: detail ? `Homebrew: ${detail}` : "Homebrew не смог установить Handy.",
      };
    }
    return {
      ok: false,
      manual: true,
      message: "Homebrew не найден. Установите Handy вручную.",
    };
  }

  return {
    ok: false,
    manual: true,
    message: "Установите Handy вручную с handy.computer.",
  };
}

function commandError(label: string, code: number | null, stderr: string) {
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
  return new Error(`${label} exited with code ${code}${detail ? `: ${detail}` : ""}`);
}

function run(binary: string, args: string[], timeoutMs: number, label: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (stdout += chunk));
    proc.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${label}: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
