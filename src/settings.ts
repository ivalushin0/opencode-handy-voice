import { Schema } from "effect";

export const DEFAULT_MODEL = "large-v3-turbo-q5_0";
export const DEFAULT_LANGUAGE = "en";
export const MODELS_URL = "https://huggingface.co/ggerganov/whisper.cpp/tree/main";

export const Settings = Schema.Struct({
  autoSend: Schema.Boolean,
  pushToTalk: Schema.Boolean,
  model: Schema.String,
  language: Schema.String,
});
export type Settings = typeof Settings.Type;

export const DEFAULT_SETTINGS: Settings = {
  autoSend: false,
  pushToTalk: false,
  model: DEFAULT_MODEL,
  language: DEFAULT_LANGUAGE,
};

// Any model from Hugging Face's whisper.cpp repo, named without its `ggml-` prefix and `.bin` suffix.
export const isModel = (value: string) => /^[\w.-]+$/.test(value) && !value.startsWith(".");

export const isLanguage = (value: string) => /^(auto|[a-z]{2,3})$/.test(value);

export function resolveModel(value: unknown): string {
  if (value === undefined || value === "") return DEFAULT_MODEL;
  if (typeof value === "string" && isModel(value)) return value;
  throw new Error(`Invalid model name "${value}"`);
}

export function resolveLanguage(value: unknown): string {
  if (value === undefined || value === "") return DEFAULT_LANGUAGE;
  if (typeof value === "string" && isLanguage(value)) return value;
  throw new Error(`Invalid language "${value}"`);
}
