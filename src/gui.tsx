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
import { DEFAULT_SETTINGS, HANDY_URL, Settings, resolveModel } from "./settings.ts";
import {
  check as checkHandy,
  install as installHandy,
  listModels,
  openApp,
  resolveHandyPath,
  transcribe,
} from "./handy.ts";
import { type ComposerButtonState, mountComposerButton } from "./composer-button.ts";
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

type Status = { kind: "dictating"; elapsed: number; heard: boolean } | { kind: "transcribing" };

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  sizeMb: Schema.Number,
  downloaded: Schema.Boolean,
  recommended: Schema.Boolean,
  languages: Schema.Array(Schema.String),
});

const HandyIpc = Ipc.define({
  id: "opencode-handy-voice.transcribe",
  methods: {
    check: {
      input: Schema.String,
      output: Schema.Struct({
        handy: Schema.Boolean,
        path: Schema.String,
        error: Schema.optional(Schema.String),
      }),
    },
    models: {
      input: Schema.String,
      output: Schema.Array(Model),
    },
    install: {
      output: Schema.Struct({
        ok: Schema.Boolean,
        message: Schema.String,
        manual: Schema.optional(Schema.Boolean),
      }),
    },
    open: {
      input: Schema.String,
      output: Schema.Boolean,
    },
    transcribe: {
      input: Schema.Struct({
        wav: Schema.Uint8Array,
        handyPath: Schema.String,
        model: Schema.String,
      }),
      output: Schema.String,
    },
  },
});

export default Plugin.define({
  stores: {
    settings: Store.global(Settings, DEFAULT_SETTINGS),
    intro: Store.global(Schema.Struct({ seen: Schema.Boolean }), { seen: false }),
  },

  setup(ctx) {
    const handy = ctx.main(HandyIpc);
    const settings = () => ctx.stores.settings.value;
    const recordCommand = `${ctx.id}.record`;
    // The keydown that holds the record shortcut, while it is held.
    let held: KeyboardEvent | undefined;
    let recording: Recording | undefined;
    // The session that was open when recording started. Use its id: the routing key can change.
    let targetId: string | undefined;
    let busy = false;
    let toast: ToastHandle | undefined;
    let meter: ReturnType<typeof setInterval> | undefined;
    const [status, setStatus] = createSignal<Status>();

    const notify = (options: ToastOptions) => {
      toast?.dismiss();
      toast = ctx.toast.show(options);
    };

    const errorText = (err: unknown) => {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError")
        return "Нет доступа к микрофону. Разрешите его для OpenCode.";
      if (name === "NotFoundError") return "Микрофон не найден.";
      if (name === "NotReadableError") return "Микрофон занят другим приложением.";
      return err instanceof Error ? err.message : String(err);
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
      targetId = undefined;
      setStatus(undefined);
    };

    const discard = () => {
      recording?.cancel();
      endRecording();
    };

    onCleanup(discard);

    const recordKeys = () => ctx.keybinds.keybind(recordCommand).join("+");

    // Handy is an external app; check that its binary is reachable before opening the mic.
    const ready = async () => {
      const check = await handy.check(settings().handyPath);
      if (check.error) {
        notify({ title: check.error, variant: "error", duration: 10000 });
        return false;
      }
      return true;
    };

    const start = async (hold: boolean) => {
      if (!ctx.screen.current()?.composer || !ctx.sessions.current()) {
        notify({ title: "Сначала откройте сессию", variant: "error" });
        return;
      }
      if (!(await ready())) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        notify({ title: "Микрофон недоступен в этом окне", variant: "error" });
        return;
      }
      recording = await record();
      targetId = ctx.sessions.current()?.id;
      if (hold && !held) {
        discard();
        notify({ title: `Удерживайте ${recordKeys()}, пока говорите` });
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
        const { handyPath, model } = settings();
        text = await handy.transcribe({
          wav: await current.stop(),
          handyPath,
          model,
        });
      } finally {
        setStatus(undefined);
      }
      if (!text) {
        notify({ title: "Речь не распознана" });
        return;
      }
      const composer = ctx.screen.current()?.composer;
      const session = ctx.sessions.current();
      if (!composer || !session) {
        await ctx.system.copy(text);
        notify({ title: "Нет открытой сессии: текст скопирован в буфер обмена" });
        return;
      }
      // The composer follows the route. If the user moved to another session,
      // keep the transcript instead of dropping it: insert into the current one.
      if (targetId && session.id !== targetId) {
        notify({
          title: "Сессия изменилась — вставляю текст в текущую",
          variant: "default",
        });
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
        notify({ title: errorText(err), variant: "error" });
      } finally {
        busy = false;
      }
    };

    const buttonState = (): ComposerButtonState => {
      const current = status();
      if (current?.kind === "dictating") return "recording";
      if (current?.kind === "transcribing") return "transcribing";
      return "idle";
    };

    const buttonTitle = (state: ComposerButtonState) => {
      const keys = recordKeys();
      const suffix = keys ? ` (${keys})` : "";
      if (state === "recording") return `Остановить диктовку${suffix}`;
      if (state === "transcribing") return "Расшифровка…";
      return `Диктовка через Handy${suffix}`;
    };

    mountComposerButton({
      state: buttonState,
      title: buttonTitle,
      toggle: () => void toggle(),
    });

    const checkNow = async () => {
      try {
        const result = await handy.check(settings().handyPath);
        if (result.handy) {
          notify({
            title: "Handy найден",
            description: result.path,
            variant: "success",
            duration: 5000,
          });
        } else {
          notify({
            title: "Handy не найден",
            description: result.error,
            variant: "error",
            duration: 10000,
          });
        }
      } catch (err) {
        notify({ title: errorText(err), variant: "error" });
      }
    };

    const openHandyApp = async () => {
      try {
        await handy.open(settings().handyPath);
        notify({
          title: "Handy открыт",
          description: "Скачайте модель в Handy и выберите её в настройках.",
        });
      } catch (err) {
        notify({
          title: "Не удалось открыть Handy",
          description: errorText(err),
          variant: "error",
          duration: 10000,
          actions: [
            {
              label: "Открыть handy.computer",
              run: () => void ctx.system.openExternal(HANDY_URL),
            },
          ],
        });
      }
    };

    const installHandyApp = async () => {
      try {
        const existing = await handy.check(settings().handyPath);
        if (existing.handy) {
          notify({
            title: "Handy уже установлен",
            description: existing.path,
            variant: "success",
            duration: 8000,
          });
          return;
        }
      } catch {
        // Fall through to the installer.
      }
      const loading = ctx.toast.show({
        title: "Установка Handy…",
        description: "Это может занять пару минут.",
        variant: "loading",
        persistent: true,
      });
      try {
        const result = await handy.install();
        if (result.ok) {
          notify({
            title: "Handy установлен",
            description: result.message,
            variant: "success",
            duration: 10000,
          });
        } else {
          notify({
            title: "Установка Handy",
            description: result.message,
            variant: result.manual ? "default" : "error",
            duration: 12000,
            actions: [
              {
                label: "Открыть handy.computer",
                run: () => void ctx.system.openExternal(HANDY_URL),
              },
            ],
          });
        }
      } catch (err) {
        notify({
          title: "Не удалось установить Handy",
          description: errorText(err),
          variant: "error",
          duration: 12000,
          actions: [
            {
              label: "Открыть handy.computer",
              run: () => void ctx.system.openExternal(HANDY_URL),
            },
          ],
        });
      } finally {
        loading.dismiss();
      }
    };

    const pickModel = async () => {
      try {
        const models = await handy.models(settings().handyPath);
        if (models.length === 0) {
          notify({ title: "Handy не вернул список моделей", variant: "error" });
          return;
        }
        const selected = await ctx.dialogs.select({
          title: "Модель Handy",
          current: settings().model || undefined,
          options: models.map((model) => ({
            title: `${model.name}${model.downloaded ? " ✓" : ""}`,
            value: model.id,
            description: [
              `${Math.round(model.sizeMb)} МБ`,
              model.languages.length ? model.languages.join(", ") : "",
              model.downloaded ? "" : "не скачана",
            ]
              .filter(Boolean)
              .join(" · "),
            category: model.downloaded
              ? "Скачанные"
              : model.recommended
                ? "Рекомендуемые"
                : "Другие",
          })),
        });
        if (!selected) return;
        const model = models.find((item) => item.id === selected);
        if (!model) return;
        if (!model.downloaded) {
          notify({
            title: "Модель ещё не скачана",
            description: "Откройте Handy и скачайте её, затем выберите снова.",
            duration: 10000,
            actions: [{ label: "Открыть Handy", run: () => void openHandyApp() }],
          });
          return;
        }
        ctx.stores.settings.update((draft) => {
          draft.model = selected;
        });
        notify({ title: "Модель выбрана", description: model.name, variant: "success" });
      } catch (err) {
        notify({
          title: "Не удалось получить модели",
          description: errorText(err),
          variant: "error",
          duration: 10000,
        });
      }
    };

    ctx.add(ComposerPill, {
      id: "status",
      show: (): ComposerPillView | undefined => {
        const current = status();
        if (current?.kind === "transcribing") return { label: "Расшифровка…", icon: "pencil-line" };
        if (current?.kind !== "dictating") return undefined;
        const keys = recordKeys();
        const hint = keys
          ? ` · ${settings().pushToTalk ? `Отпустите ${keys}` : `${keys} — стоп`}`
          : "";
        return {
          label: `Диктовка ${formatElapsed(current.elapsed)}${hint}`,
          icon: current.heard ? "waveform" : "dash",
          tone: current.heard ? "success" : "warning",
          title: current.heard
            ? "Микрофон слышит вас. Нажмите, чтобы остановить"
            : "Микрофон не слышит звук",
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
              label: "Настройки диктовки",
              icon: "info",
              run: () => ctx.layout.settings("handy-voice"),
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
      id: "handy-voice",
      title: "Handy Voice",
      icon: "waveform",
      entries: [
        {
          id: "handy-voice",
          title: "Handy Voice",
          description: "Локальная диктовка через Handy",
          keywords: "голос диктовка микрофон handy gigaam whisper",
        },
      ],
      render: () => (
        <SettingsView
          ui={ctx.ui}
          system={ctx.system}
          settings={ctx.stores.settings}
          keys={() => ctx.keybinds.keybind(recordCommand)}
          onCheck={checkNow}
          onInstall={installHandyApp}
          onOpenHandy={openHandyApp}
          onPickModel={pickModel}
        />
      ),
    });

    ctx.add(Command, (): Command => ({
      id: "record",
      title: "Handy Voice: диктовка (начать/остановить)",
      section: "prompt",
      bind: "mod+shift+m",
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
      title: "Handy Voice: отменить запись",
      section: "prompt",
      run: () => {
        if (recording) discard();
      },
    }));
  },

  main(ctx) {
    ctx.provide(HandyIpc, {
      check: async (value) => checkHandy(value),

      models: async (value) => listModels(resolveHandyPath(value)),

      install: async () => installHandy(),

      open: async (value) => {
        await openApp(resolveHandyPath(value));
        return true;
      },

      transcribe: async ({ wav, handyPath, model }) => {
        const binary = resolveHandyPath(handyPath);
        const started = Date.now();
        const result = await transcribe(wav, {
          binary,
          model: resolveModel(model),
        });
        ctx.log.write(
          "debug",
          `[handy-voice] ${result.text.length} chars from ${wav.length} bytes in ${Date.now() - started} ms`,
        );
        return result.text;
      },
    });
  },
});
