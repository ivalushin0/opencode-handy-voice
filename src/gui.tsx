import { Schema } from "effect";
import { createSignal, onCleanup } from "solid-js";
import {
  Command,
  ComposerPill,
  type ComposerPillView,
  Ipc,
  Plugin,
  SettingsPage,
  Store,
  type ToastHandle,
  type ToastOptions,
} from "@opencode/plugin/gui";
import { type Recording, record } from "./recorder.ts";
import { SettingsView } from "./settings-page.tsx";
import { DEFAULT_SETTINGS, Settings, resolveLanguage, resolveModel } from "./settings.ts";
import { downloadModel, findModel, findWhisper, modelSize, transcribe } from "./whisper.ts";
import { MAX_SECONDS } from "./wav.ts";

// RMS above this counts as sound. Silence with noise suppression stays well below.
const SOUND_LEVEL = 0.01;
// How long the pill shows sound after the last sound.
const HEARD_MS = 1000;
const METER_MS = 100;
const MODIFIERS = {
  Meta: "metaKey",
  Control: "ctrlKey",
  Alt: "altKey",
  Shift: "shiftKey",
} as const;

const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

type Status =
  | { kind: "dictating"; elapsed: number; heard: boolean }
  | { kind: "transcribing" }
  | { kind: "downloading"; size: string };

const DictationIpc = Ipc.define({
  id: "opencode-dictation.whisper",
  methods: {
    check: {
      input: Schema.String,
      output: Schema.Struct({
        whisper: Schema.Boolean,
        model: Schema.Boolean,
        name: Schema.String,
        size: Schema.String,
        error: Schema.optional(Schema.String),
      }),
    },
    download: { input: Schema.String },
    transcribe: {
      input: Schema.Struct({
        wav: Schema.Uint8Array,
        model: Schema.String,
        language: Schema.String,
      }),
      output: Schema.String,
    },
  },
});

export default Plugin.define({
  os: ["macos"],
  stores: {
    settings: Store.global(Settings, DEFAULT_SETTINGS),
    intro: Store.global(Schema.Struct({ seen: Schema.Boolean }), { seen: false }),
  },

  setup(ctx) {
    const whisper = ctx.main(DictationIpc);
    const settings = () => ctx.stores.settings.value;
    const recordCommand = `${ctx.id}.record`;
    // The keydown that holds the record shortcut, while it is held.
    let held: KeyboardEvent | undefined;
    let recording: Recording | undefined;
    let busy = false;
    let toast: ToastHandle | undefined;
    let meter: ReturnType<typeof setInterval> | undefined;
    const [status, setStatus] = createSignal<Status>();

    const notify = (options: ToastOptions) => {
      toast?.dismiss();
      toast = ctx.toast.show(options);
    };

    const startMeter = (current: Recording) => {
      const started = Date.now();
      let lastSound = 0;
      const tick = () => {
        const now = Date.now();
        if (now - started >= MAX_SECONDS * 1000) {
          void toggle();
          return;
        }
        if (current.level() > SOUND_LEVEL) lastSound = now;
        setStatus({ kind: "dictating", elapsed: now - started, heard: now - lastSound < HEARD_MS });
      };
      tick();
      meter = setInterval(tick, METER_MS);
    };

    const endRecording = () => {
      if (recording && !ctx.stores.intro.value.seen) ctx.stores.intro.set({ seen: true });
      clearInterval(meter);
      meter = undefined;
      recording = undefined;
      setStatus(undefined);
    };

    const discard = () => {
      recording?.cancel();
      endRecording();
    };

    onCleanup(discard);

    const recordKeys = () => ctx.keybinds.keybind(recordCommand).join("");

    // True when whisper-cli and the model are ready, after an optional download.
    const ready = async () => {
      const check = await whisper.check(settings().model);
      if (check.error) {
        notify({ title: check.error, variant: "error" });
        return false;
      }
      if (!check.whisper) {
        notify({
          title: "whisper-cli not found",
          description: "Install it with: brew install whisper-cpp",
          variant: "error",
        });
        return false;
      }
      if (check.model) return true;
      const confirmed = await ctx.dialogs.confirm({
        title: "Download the speech model?",
        description: `Dictation needs the ${check.name} whisper model (${check.size}). It is downloaded once from Hugging Face.`,
        confirm: "Download",
      });
      if (!confirmed) return false;
      setStatus({ kind: "downloading", size: check.size });
      try {
        await whisper.download(check.name);
      } finally {
        setStatus(undefined);
      }
      return true;
    };

    const start = async (hold: boolean) => {
      const composer = ctx.screen.current()?.composer;
      if (!composer) {
        notify({ title: "Open a session first", variant: "error" });
        return;
      }
      if (!(await ready())) return;
      recording = await record();
      if (hold && !held) {
        discard();
        notify({ title: `Hold ${recordKeys()} while you talk` });
        return;
      }
      toast?.dismiss();
      startMeter(recording);
    };

    const finish = async (current: Recording) => {
      endRecording();
      setStatus({ kind: "transcribing" });
      let text: string;
      try {
        const { model, language } = settings();
        text = await whisper.transcribe({ wav: await current.stop(), model, language });
      } finally {
        setStatus(undefined);
      }
      if (!text) {
        notify({ title: "No speech detected" });
        return;
      }
      const composer = ctx.screen.current()?.composer;
      const session = ctx.sessions.current();
      if (!composer || !session) {
        await ctx.system.copy(text);
        notify({ title: "No session open: transcript copied to clipboard" });
        return;
      }
      // A non-empty prompt may hold mentions or attachments, so it is left for the user to send.
      if (settings().autoSend && composer.text().trim() === "") {
        const model = composer.model();
        const { client } = session.server;
        if (model)
          await client.session.switchModel({
            sessionID: session.id,
            model: { id: model.modelID, providerID: model.providerID, variant: model.variant },
          });
        await client.session.prompt({ sessionID: session.id, text });
        return;
      }
      composer.insert(text);
      composer.focus();
    };

    const toggle = async (hold = false) => {
      if (busy) return;
      busy = true;
      try {
        await (recording ? finish(recording) : start(hold));
      } catch (err) {
        discard();
        notify({ title: err instanceof Error ? err.message : String(err), variant: "error" });
      } finally {
        busy = false;
      }
    };

    ctx.add(ComposerPill, {
      id: "status",
      show: (): ComposerPillView | undefined => {
        const current = status();
        if (current?.kind === "downloading")
          return { label: `Downloading speech model (${current.size})…`, icon: "download" };
        if (current?.kind === "transcribing")
          return { label: "Transcribing…", icon: "pencil-line" };
        if (current?.kind !== "dictating") return undefined;
        const keys = recordKeys();
        const hint = keys ? ` · ${settings().pushToTalk ? `Release ${keys}` : keys} to stop` : "";
        return {
          label: `Dictating ${formatElapsed(current.elapsed)}${hint}`,
          icon: current.heard ? "waveform" : "dash",
          tone: current.heard ? "success" : "warning",
          title: current.heard ? "The mic hears you. Click to stop" : "No sound from the mic",
          run: () => void toggle(),
        };
      },
    });

    ctx.add(ComposerPill, {
      id: "intro",
      order: 1,
      show: (): ComposerPillView | undefined =>
        status()?.kind === "dictating" && !ctx.stores.intro.value.seen
          ? {
              label: "Dictation settings",
              icon: "info",
              run: () => ctx.layout.settings("dictation"),
            }
          : undefined,
    });

    // In push-to-talk, the shortcut's keydown and keyup drive recording. Commands only fire on keydown.
    const release = () => {
      held = undefined;
      if (recording) void toggle();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!settings().pushToTalk) return;
      if (event.repeat || !ctx.keybinds.matches(recordCommand, event)) return;
      held = event;
      if (!recording) void toggle(true);
    };
    // macOS sends no keyup for a key released while ⌘ is down, so a released modifier also counts.
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held) return;
      const modifier = MODIFIERS[event.key as keyof typeof MODIFIERS];
      if (event.code === held.code || (modifier && held[modifier])) release();
    };
    const onBlur = () => {
      if (held) release();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    });

    ctx.add(SettingsPage, {
      id: "dictation",
      title: "Dictation",
      icon: "waveform",
      entries: [
        {
          id: "dictation",
          title: "Dictation",
          description: "Voice dictation with whisper.cpp",
          keywords: "voice speech whisper microphone auto-send push-to-talk model language",
        },
      ],
      render: () => (
        <SettingsView
          ui={ctx.ui}
          system={ctx.system}
          settings={ctx.stores.settings}
          keys={() => ctx.keybinds.keybind(recordCommand)}
        />
      ),
    });

    ctx.add(Command, (): Command => ({
      id: "record",
      title: "Dictation: record / transcribe",
      section: "prompt",
      bind: "mod+d",
      editable: true,
      // The shortcut's own keydown runs first. In push-to-talk, it already handled the key.
      run: () => {
        setTimeout(() => {
          if (!held) void toggle();
        });
      },
    }));

    ctx.add(Command, (): Command => ({
      id: "cancel",
      title: "Dictation: cancel recording",
      section: "prompt",
      run: () => {
        if (recording) discard();
      },
    }));
  },

  main(ctx) {
    const log = (level: "debug" | "info", message: string) =>
      ctx.log.write(level, `[dictation] ${message}`);
    let downloading: Promise<void> | undefined;

    ctx.provide(DictationIpc, {
      check: async (name) => {
        try {
          const model = resolveModel(name);
          const found = findModel(model) !== undefined;
          return {
            whisper: findWhisper() !== undefined,
            model: found,
            name: model,
            size: found ? "" : await modelSize(model),
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { whisper: false, model: false, name: "", size: "", error };
        }
      },

      download: async (name) => {
        const model = resolveModel(name);
        downloading ??= downloadModel(model)
          .then(() => log("info", `Downloaded model ${model}`))
          .finally(() => (downloading = undefined));
        await downloading;
      },

      transcribe: async ({ wav, model, language }) => {
        const modelFile = findModel(resolveModel(model));
        const binary = findWhisper();
        if (!modelFile || !binary) throw new Error("Speech model or whisper-cli missing");
        const started = Date.now();
        const text = await transcribe(wav, {
          binary,
          model: modelFile,
          language: resolveLanguage(language),
        });
        log("debug", `Transcribed ${wav.length} bytes in ${Date.now() - started} ms`);
        return text;
      },
    });
  },
});
