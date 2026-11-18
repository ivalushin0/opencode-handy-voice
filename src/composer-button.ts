import { createEffect, onCleanup } from "solid-js";

export type ComposerButtonState = "idle" | "recording" | "transcribing";

type Options = {
  state: () => ComposerButtonState;
  title: (state: ComposerButtonState) => string;
  toggle: () => void;
};

const MIC_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>`;

type Slot = {
  host: HTMLElement;
  submit: HTMLElement;
  bottom: number;
};

/**
 * Puts a mic button immediately left of the composer's send button.
 *
 * The GUI SDK has no composer action registry, so this follows the same DOM
 * structure the app's composer renders: `[data-slot="composer-actions"]` with
 * `[data-action="composer-submit"]` inside. It survives composer remounts.
 */
export function mountComposerButton(options: Options) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.handyVoice = "dictate";
  button.innerHTML = MIC_SVG;
  button.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0",
    "margin:0 4px 0 2px",
    "border:0",
    "border-radius:8px",
    "background:transparent",
    "color:inherit",
    "cursor:pointer",
    "flex-shrink:0",
    "line-height:0",
    "box-sizing:border-box",
    "transition:background-color 120ms ease,color 120ms ease,opacity 120ms ease,box-shadow 120ms ease",
  ].join(";");

  let hovered = false;
  let frame = 0;
  let bootFrame = 0;
  let host: HTMLElement | undefined;
  let anchor: HTMLElement | undefined;
  let observer: MutationObserver | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const apply = () => {
    const state = options.state();
    const recording = state === "recording";
    const busy = state === "transcribing";
    const label = options.title(state);
    button.disabled = busy;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(recording));
    button.title = label;
    button.style.color = recording ? "#ef4444" : "inherit";
    button.style.background = recording
      ? "color-mix(in srgb, #ef4444 12%, transparent)"
      : hovered
        ? "color-mix(in srgb, currentColor 10%, transparent)"
        : "transparent";
    button.style.opacity = busy ? "0.55" : "1";
    button.style.cursor = busy ? "default" : "pointer";
    button.style.boxShadow = recording
      ? "0 0 0 3px color-mix(in srgb, #ef4444 14%, transparent)"
      : "none";
  };

  const findComposer = (): Slot | undefined => {
    let best: Slot | undefined;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="composer-actions"]'),
    );
    for (const candidate of candidates) {
      const submit = candidate.querySelector<HTMLElement>('[data-action="composer-submit"]');
      if (!submit || candidate.getClientRects().length === 0) continue;
      if (getComputedStyle(candidate).visibility === "hidden") continue;
      const rect = candidate.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (!best || rect.bottom > best.bottom) {
        best = { host: candidate, submit, bottom: rect.bottom };
      }
    }
    return best;
  };

  const ensure = () => {
    frame = 0;
    const slot = findComposer();
    if (!slot) {
      button.remove();
      host = undefined;
      anchor = undefined;
      return;
    }

    let top: HTMLElement = slot.submit;
    while (top.parentElement && top.parentElement !== slot.host) top = top.parentElement;
    if (top.parentElement !== slot.host) {
      button.remove();
      host = undefined;
      anchor = undefined;
      return;
    }

    if (
      host === slot.host &&
      anchor === top &&
      anchor.isConnected &&
      button.parentElement === host &&
      button.nextElementSibling === anchor
    ) {
      return;
    }

    host = slot.host;
    anchor = top;
    const size = Math.round(slot.submit.getBoundingClientRect().height) || 28;
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
    button.style.borderRadius = getComputedStyle(slot.submit).borderRadius || "8px";
    host.insertBefore(button, anchor);
    apply();
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(ensure);
  };

  const boot = () => {
    bootFrame = 0;
    if (!document.body) {
      bootFrame = requestAnimationFrame(boot);
      return;
    }
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    ensure();
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.toggle();
  });
  button.addEventListener("mouseenter", () => {
    hovered = true;
    apply();
  });
  button.addEventListener("mouseleave", () => {
    hovered = false;
    apply();
  });

  createEffect(() => {
    options.state();
    apply();
  });

  bootFrame = requestAnimationFrame(boot);
  poll = setInterval(schedule, 500);

  onCleanup(() => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    observer?.disconnect();
    observer = undefined;
    if (frame) cancelAnimationFrame(frame);
    if (bootFrame) cancelAnimationFrame(bootFrame);
    button.remove();
  });
}
