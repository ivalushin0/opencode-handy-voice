import { createSignal, type Accessor, type JSX } from "solid-js";
import type { Persisted, System, Ui } from "@opencode/plugin/gui";
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL,
  MODELS_URL,
  type Settings,
  isLanguage,
  isModel,
} from "./settings.ts";

type Props = {
  ui: Ui;
  system: System;
  settings: Persisted<Settings, Settings>;
  keys: Accessor<readonly string[]>;
};

// The markup of the host's settings screens, whose stylesheet gives the page its look. Desktop 2.2.5 has no
// `ui.SettingsLayout` or `ui.SettingsRow` yet.
function Layout(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="settings-tab-title">{props.title}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{props.description}</span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section">
          <div data-component="settings-list">{props.children}</div>
        </section>
      </div>
    </>
  );
}

function Row(props: { title: string; description: JSX.Element; children: JSX.Element }) {
  return (
    <div data-component="settings-row">
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">{props.title}</div>
        <div data-slot="settings-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-row-control">{props.children}</div>
    </div>
  );
}

// A text setting saved on Enter or Apply, so a half-typed model name never triggers a download.
function TextRow(props: {
  ui: Ui;
  title: string;
  description: JSX.Element;
  value: string;
  placeholder: string;
  valid: (value: string) => boolean;
  save: (value: string) => void;
}) {
  const [draft, setDraft] = createSignal(props.value);
  const valid = () => draft() === "" || props.valid(draft());
  const dirty = () => draft() !== props.value;
  const save = () => {
    if (valid() && dirty()) props.save(draft());
  };
  return (
    <Row title={props.title} description={props.description}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        {/* The host's field fills its parent, which would push the button out of the row. */}
        <div style={{ width: "200px" }}>
          <props.ui.TextInput
            label={props.title}
            value={draft()}
            placeholder={props.placeholder}
            onInput={setDraft}
            onSubmit={save}
            invalid={!valid()}
          />
        </div>
        <props.ui.Button variant="neutral" disabled={!valid() || !dirty()} onClick={save}>
          Apply
        </props.ui.Button>
      </div>
    </Row>
  );
}

export function SettingsView(props: Props) {
  const value = () => props.settings.value;
  const set = <K extends keyof Settings>(key: K, next: Settings[K]) =>
    props.settings.update((draft) => {
      draft[key] = next;
      return undefined;
    });
  const shortcut = () => {
    const keys = props.keys();
    return keys.length ? (
      <props.ui.Keybind keys={keys} />
    ) : (
      <span class="text-v2-text-text-muted">Not bound</span>
    );
  };

  return (
    <Layout
      title="Dictation"
      description="Voice dictation on your Mac with whisper.cpp. No audio leaves the machine."
    >
      <Row
        title="Shortcut"
        description="Change it in Settings → Shortcuts, under Dictation: record / transcribe."
      >
        {shortcut()}
      </Row>
      <Row
        title="Push-to-talk"
        description="Hold the shortcut while you talk, and let go to stop. Off: press once to start, once to stop."
      >
        <props.ui.Switch
          label="Push-to-talk"
          hideLabel
          checked={value().pushToTalk}
          onChange={(checked) => set("pushToTalk", checked)}
        />
      </Row>
      <Row title="Send automatically" description="Send the transcript as soon as it is ready.">
        <props.ui.Switch
          label="Send automatically"
          hideLabel
          checked={value().autoSend}
          onChange={(checked) => set("autoSend", checked)}
        />
      </Row>
      <TextRow
        ui={props.ui}
        title="Language"
        value={value().language}
        placeholder={DEFAULT_LANGUAGE}
        valid={isLanguage}
        save={(next) => set("language", next || DEFAULT_LANGUAGE)}
        description="A whisper language code such as en or fr, or auto to detect it (adds a short delay)."
      />
      <TextRow
        ui={props.ui}
        title="Model"
        value={value().model}
        placeholder={DEFAULT_MODEL}
        valid={isModel}
        save={(next) => set("model", next || DEFAULT_MODEL)}
        description={
          <>
            Any whisper.cpp model from{" "}
            <a
              href={MODELS_URL}
              onClick={(event) => {
                event.preventDefault();
                props.system.openExternal(MODELS_URL);
              }}
            >
              Hugging Face
            </a>
            , named without ggml- and .bin. Downloads on first use.
          </>
        }
      />
    </Layout>
  );
}
