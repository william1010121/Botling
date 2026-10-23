import { t } from "./i18n";
import type { AnimatedHead, CharacterClip, ChatState } from "./types";
import { onScreen, windowVisible } from "./visible";

type Player = {
  element: HTMLElement;
  still: HTMLImageElement;
  motion: HTMLImageElement;
  head: AnimatedHead;
  clip: CharacterClip | null;
  preview: boolean;
  waveUntil: number;
  timer?: ReturnType<typeof setTimeout>;
};

let heads: AnimatedHead[] = [];
const players = new Set<Player>();
const failed = new Set<string>();
let observer: IntersectionObserver | null = null;
let media: MediaQueryList | null = null;
let listening = false;
let dialog: HTMLDialogElement | null = null;
let botID: string | null = null;
let previousIDs = new Set<string>();
let wasWorking = false;
let turnStartID: string | undefined;

function listen(): void {
  if (listening) return;
  listening = true;
  media = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  media?.addEventListener?.("change", refreshAvatarVisibility);
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(refreshAvatarVisibility);
  }
  for (const name of ["scroll", "resize", "visibilitychange"]) {
    (name === "resize" ? window : document).addEventListener(name, refreshAvatarVisibility, { capture: true, passive: true });
  }
}

export function configureAnimatedHeads(value?: AnimatedHead[] | null): void {
  heads = value ?? [];
  if (heads.length) listen();
}

/** Original, custom and group avatars keep their exact image element and source. */
export function characterAvatar(src: string | null): HTMLElement {
  const head = heads.find((entry) => entry.avatar === src);
  if (!head) {
    const image = document.createElement("img");
    image.className = "avatar";
    image.alt = "";
    if (src) image.src = src;
    return image;
  }
  const player = createPlayer(head);
  player.element.addEventListener("click", () => openLibrary(head));
  return player.element;
}

function createPlayer(head: AnimatedHead, preview = false): Player {
  const element = document.createElement(preview ? "div" : "button");
  element.className = preview ? "avatar-preview animated-avatar" : "avatar animated-avatar";
  element.dataset.animatedHead = head.engine;
  if (element instanceof HTMLButtonElement) {
    element.type = "button";
    element.title = t("avatar.library");
    element.setAttribute("aria-label", `${head.engine === "claude" ? "Claude" : "Codex"} · ${t("avatar.library")}`);
  }
  const still = document.createElement("img");
  still.className = "avatar-still";
  still.alt = "";
  still.src = head.avatar;
  const motion = document.createElement("img");
  motion.className = "avatar-motion";
  motion.alt = "";
  const hat = document.createElement("img");
  hat.className = "avatar-hat";
  hat.alt = "";
  hat.src = head.hat;
  element.append(still, motion, hat);
  const player: Player = { element, still, motion, head, clip: null, preview, waveUntil: 0 };
  motion.addEventListener("load", () => {
    if (motion.getAttribute("src") && player.clip && eligible(player)) element.classList.add("playing");
  });
  motion.addEventListener("error", () => {
    if (player.clip && motion.getAttribute("src")) failed.add(player.clip.file);
    stop(player);
  });
  // A missing full-size preview can still fall back to the established embedded PNG avatar.
  still.addEventListener("error", () => { if (still.src !== head.avatar) still.src = head.avatar; });
  players.add(player);
  observer?.observe(element);
  return player;
}

function eligible(player: Player): boolean {
  return !!observer && !media?.matches && windowVisible() && !document.body.classList.contains("board")
    && (!dialog?.open || player.preview) && onScreen(player.element);
}

function stop(player: Player): void {
  player.element.classList.remove("playing");
  player.motion.removeAttribute("src");
}

/** Removing the GIF source stops decoding offscreen/hidden images, rather than hiding a running GIF. */
export function refreshAvatarVisibility(): void {
  for (const player of players) {
    if (!player.element.isConnected) {
      stop(player);
      clearTimeout(player.timer);
      observer?.unobserve(player.element);
      players.delete(player);
    } else if (!player.clip || failed.has(player.clip.file) || !eligible(player)) {
      stop(player);
    } else if (player.motion.getAttribute("src") !== player.clip.file) {
      player.motion.src = player.clip.file;
    }
  }
}

function use(player: Player, action: CharacterClip["action"] | null, still = player.head.avatar): void {
  const clip = action ? player.head.clips.find((item) => item.kind === "avatar" && item.action === action) ?? null : null;
  if (player.clip?.id !== clip?.id) stop(player);
  player.clip = clip;
  if (player.still.getAttribute("src") !== still) player.still.src = still;
  player.element.dataset.pose = action ?? "static";
}

/** Only the live bubble, or the newest reply while idle, animates. History is always still. */
export function updateAnimatedAvatars(state: ChatState, arrivals: boolean): void {
  const latest = [...state.messages].reverse().find((message) => message.role === "bot");
  if (state.botID !== botID) {
    botID = state.botID;
    previousIDs.clear();
    wasWorking = false;
    dialog?.close();
    dialog?.remove();
    dialog = null;
  }
  if (state.working && !wasWorking) turnStartID = latest?.id;
  const completed = arrivals && latest && !state.working && !latest.interrupted
    && (!previousIDs.has(latest.id) || (wasWorking && latest.id !== turnStartID));
  const last = state.messages[state.messages.length - 1];
  const failedTurn = last?.role === "error";
  for (const player of players) {
    if (player.preview) continue;
    const row = player.element.closest<HTMLElement>(".row");
    clearTimeout(player.timer);
    if (row?.classList.contains("typing")) {
      const waiting = state.avatarMood === "think";
      const asleep = state.avatarMood === "sleep";
      use(player, waiting || asleep ? null : "typing", waiting ? player.head.thinking : asleep ? player.head.sleeping : player.head.avatar);
    } else if (!state.working && latest && row?.dataset.id === latest.id && !latest.interrupted && !failedTurn && state.avatarMood !== "sleep" && state.avatarMood !== "think") {
      const wave = player.head.clips.find((clip) => clip.kind === "avatar" && clip.action === "wave");
      if (completed && wave) player.waveUntil = Date.now() + wave.duration;
      use(player, player.waveUntil > Date.now() ? "wave" : "blink");
      if (player.waveUntil > Date.now()) {
        player.timer = setTimeout(() => { use(player, "blink"); refreshAvatarVisibility(); }, player.waveUntil - Date.now());
      }
    } else {
      player.waveUntil = 0;
      const current = latest && row?.dataset.id === latest.id;
      use(player, null, current && (failedTurn || state.avatarMood === "think") ? player.head.thinking : current && (state.avatarMood === "sleep" || latest.interrupted) ? player.head.sleeping : player.head.avatar);
    }
  }
  previousIDs = new Set(state.messages.map((message) => message.id));
  wasWorking = state.working;
  refreshAvatarVisibility();
}

function clipLabel(clip: CharacterClip): string {
  return `${clip.engine === "claude" ? "Claude" : "Codex"} · ${t(clip.kind === "avatar" ? "avatar.portrait" : "avatar.sticker")} · ${t(`avatar.${clip.action}`)}`;
}

/** An explicit preview makes all twelve supplied actions available without guessing emotion. */
function openLibrary(selectedHead: AnimatedHead): void {
  dialog?.close();
  dialog?.remove();
  const sheet = document.createElement("dialog");
  dialog = sheet;
  sheet.className = "avatar-library";
  sheet.setAttribute("aria-labelledby", "avatar-library-title");
  const title = document.createElement("h2");
  title.id = "avatar-library-title";
  title.textContent = t("avatar.library");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "plain avatar-library-close";
  close.textContent = t("common.close");
  close.addEventListener("click", () => sheet.close());
  const preview = createPlayer(selectedHead, true);
  const label = document.createElement("p");
  label.setAttribute("aria-live", "polite");
  const hint = document.createElement("p");
  hint.className = "avatar-library-hint";
  hint.textContent = t("avatar.previewHint");
  const grid = document.createElement("div");
  grid.className = "avatar-library-grid";
  const choose = (head: AnimatedHead, clip: CharacterClip): void => {
    stop(preview);
    preview.head = head;
    preview.clip = clip;
    preview.still.src = clip.poster;
    preview.element.classList.toggle("sticker-preview", clip.kind === "sticker");
    // The preview shows the supplied source art without the bot's hat.
    preview.element.querySelector<HTMLImageElement>(".avatar-hat")!.hidden = true;
    preview.element.dataset.clip = clip.id;
    label.textContent = clipLabel(clip);
    for (const button of grid.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.clip === clip.id));
    refreshAvatarVisibility();
  };
  const listed = new Set<string>();
  for (const head of [selectedHead, ...heads]) for (const clip of head.clips) {
    // Multiple bot hats share the same twelve source clips.
    if (listed.has(clip.id)) continue;
    listed.add(clip.id);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.clip = clip.id;
    button.setAttribute("aria-pressed", "false");
    const image = document.createElement("img");
    image.src = clip.poster;
    image.alt = "";
    image.loading = "lazy";
    const name = document.createElement("span");
    name.textContent = clipLabel(clip);
    button.append(image, name);
    button.addEventListener("click", () => choose(head, clip));
    grid.append(button);
  }
  sheet.append(close, title, preview.element, label, hint, grid);
  sheet.addEventListener("close", () => {
    preview.clip = null;
    stop(preview);
    sheet.remove();
    if (dialog === sheet) dialog = null;
    refreshAvatarVisibility();
  });
  document.body.append(sheet);
  sheet.showModal();
  const initial = selectedHead.clips.find((clip) => clip.kind === "avatar" && clip.action === "blink");
  if (initial) choose(selectedHead, initial);
  refreshAvatarVisibility();
}
