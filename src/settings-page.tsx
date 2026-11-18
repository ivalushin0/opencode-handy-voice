import { createSignal, type Accessor, type JSX } from "solid-js";
import type { Persisted, System, Ui } from "@opencode/plugin/gui";
import { HANDY_URL, type Settings, isModel } from "./settings.ts";

type Props = {
  ui: Ui;
  system: System;
  settings: Persisted<Settings, Settings>;
  keys: Accessor<readonly string[]>;
  onCheck: () => void | Promise<void>;
  onInstall: () => void | Promise<void>;
  onOpenHandy: () => void | Promise<void>;
  onPickModel: () => void | Promise<void>;
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

// A text setting saved on Enter or Apply, so a half-typed value is never used.
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
          Применить
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
      <span class="text-v2-text-text-muted">Не назначено</span>
    );
  };

  return (
    <Layout
      title="Handy Voice"
      description="Локальная диктовка через Handy. Звук и текст не уходят с компьютера."
    >
      <Row
        title="Установка Handy"
        description="Windows: winget (cjpais.Handy). macOS: Homebrew. Если пакетного менеджера нет — откроется сайт."
      >
        <props.ui.Button variant="neutral" onClick={() => void props.onInstall()}>
          Установить
        </props.ui.Button>
      </Row>
      <Row
        title="Открыть Handy"
        description="Откройте Handy, скачайте модель и вернитесь сюда, чтобы выбрать её."
      >
        <props.ui.Button variant="neutral" onClick={() => void props.onOpenHandy()}>
          Открыть
        </props.ui.Button>
      </Row>
      <Row
        title="Модели Handy"
        description="Список моделей Handy: скачанные отмечены галочкой. Для русского — GigaAM v3."
      >
        <props.ui.Button variant="neutral" onClick={() => void props.onPickModel()}>
          Выбрать
        </props.ui.Button>
      </Row>
      <Row
        title="Сочетание клавиш"
        description="Меняется в Settings → Shortcuts, раздел Handy Voice: диктовка."
      >
        {shortcut()}
      </Row>
      <Row
        title="Push-to-talk"
        description="Удерживайте сочетание, пока говорите, и отпустите, чтобы остановить. Выключено: нажатие — старт, ещё одно — стоп."
      >
        <props.ui.Switch
          label="Push-to-talk"
          hideLabel
          checked={value().pushToTalk}
          onChange={(checked) => set("pushToTalk", checked)}
        />
      </Row>
      <Row title="Отправлять сразу" description="Отправлять расшифровку сразу, без проверки.">
        <props.ui.Switch
          label="Отправлять сразу"
          hideLabel
          checked={value().autoSend}
          onChange={(checked) => set("autoSend", checked)}
        />
      </Row>
      <Row title="Проверка" description="Убедиться, что Handy установлен и доступен из OpenCode.">
        <props.ui.Button variant="neutral" onClick={() => void props.onCheck()}>
          Проверить
        </props.ui.Button>
      </Row>
      <TextRow
        ui={props.ui}
        title="Путь к Handy"
        value={value().handyPath}
        placeholder="Найти автоматически"
        valid={() => true}
        save={(next) => set("handyPath", next)}
        description={
          <>
            Пусто — найти автоматически. На Windows обычно{" "}
            <code>%LOCALAPPDATA%\Handy\handy.exe</code>. Скачать:{" "}
            <a
              href={HANDY_URL}
              onClick={(event) => {
                event.preventDefault();
                props.system.openExternal(HANDY_URL);
              }}
            >
              handy.computer
            </a>
            .
          </>
        }
      />
      <TextRow
        ui={props.ui}
        title="Модель"
        value={value().model}
        placeholder="Модель из Handy"
        valid={isModel}
        save={(next) => set("model", next)}
        description="Пусто — модель, выбранная в Handy. Для русского: GigaAM v3 (gigaam-v3-e2e-rnnt)."
      />
    </Layout>
  );
}
