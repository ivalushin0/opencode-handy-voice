import { Schema } from "effect";

export const HANDY_URL = "https://handy.computer";

export const Settings = Schema.Struct({
  autoSend: Schema.Boolean,
  pushToTalk: Schema.Boolean,
  // Empty means: find Handy automatically.
  handyPath: Schema.String,
  // Empty means: use the model selected in Handy.
  model: Schema.String,
});
export type Settings = typeof Settings.Type;

export const DEFAULT_SETTINGS: Settings = {
  autoSend: false,
  pushToTalk: false,
  handyPath: "",
  model: "",
};

// Handy model ids look like `handy-computer/gigaam-v3-e2e-rnnt-gguf/gigaam-v3-e2e-rnnt-Q8_0.gguf`.
export const isModel = (value: string) =>
  /^[A-Za-z0-9._:/-]+$/.test(value) && !value.includes("..");

export function resolveModel(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value === "string" && isModel(value)) return value;
  throw new Error(`Invalid Handy model id "${value}"`);
}
