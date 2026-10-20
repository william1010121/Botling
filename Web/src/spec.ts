import { post } from "./bridge";
import { componentElement, keepFrames } from "./components";
import type { ComponentInfo, PinRefresh, SpecOrigin, SpecState } from "./types";

/**
 * The component spec workspace in the right panel (`chat.html?spec=1`): a live preview with
 * switchable sample data, the spec's fields (blue where you set them, purple where Maintainer
 * did), Test run through the usual allow flow, a side conversation with Maintainer whose
 * questions come with suggested answers, and Build it. Every change goes to Swift, which sends
 * the spec back; field edits and the conversation are one state, so they stay in sync.
 */

const icons = {
  cube: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
  collapse: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`,
  expand: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`,
  narrow: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>`,
  send: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  run: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
};

/** Draws data with no template yet: its values as rows, lists as their first items. */
const plainTemplate = `<style>
.g{font:13px -apple-system,"PingFang TC",sans-serif;color:#EDEDF0;border:1px solid #2A2A31;border-radius:12px;padding:8px 10px;background:#141417}
.r{display:flex;gap:10px;padding:3px 0;align-items:baseline}.k{color:#8E8E96;min-width:84px;flex:none}.v{min-width:0;overflow-wrap:anywhere}
.l{margin:2px 0 2px 12px;color:#C8C8CE}.e{color:#8E8E96}
</style><div class="g" id="g"></div><script>
(() => {
  const root = document.getElementById('g');
  const text = (v) => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const add = (cls, words) => { const d = document.createElement('div'); d.className = cls; d.textContent = words; root.append(d); return d; };
  const data = window.ccb.data;
  if (data === null || data === undefined || (Array.isArray(data) && !data.length)) { add('e', 'Nothing to show'); return; }
  if (typeof data !== 'object') { add('v', text(data)); return; }
  const rows = Array.isArray(data) ? data.map((v, i) => [String(i + 1), v]) : Object.entries(data);
  for (const [key, value] of rows.slice(0, 12)) {
    const row = add('r', '');
    const k = document.createElement('span'); k.className = 'k'; k.textContent = key;
    const v = document.createElement('span'); v.className = 'v';
    if (Array.isArray(value)) {
      v.textContent = value.length + (value.length === 1 ? ' item' : ' items');
      row.append(k, v);
      for (const item of value.slice(0, 4)) add('l', '· ' + (item && typeof item === 'object' ? Object.values(item).slice(0, 3).map(text).join(' · ') : text(item)));
      continue;
    }
    v.textContent = text(value);
    row.append(k, v);
  }
})();
</script>`;

const plainInfo: ComponentInfo = { template: plainTemplate, version: 0, working: false, updated: false, hasPrevious: false };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(className: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
  const element = el("button", className);
  element.innerHTML = text;
  if (label) {
    element.setAttribute("aria-label", label);
    element.title = label;
  }
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

function refreshWords(refresh: PinRefresh, minutes: number): string {
  return refresh === "shown" ? "When shown" : refresh === "interval" ? `Every ${minutes} min` : "Only on ↻";
}

export class SpecPanel {
  private state: SpecState | null = null;
  /** The sample each spec previews with, by spec id (a label). */
  private readonly sample = new Map<string, string>();
  private content: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement) {}

  update(state: SpecState): void {
    this.state = state;
    this.draw();
  }

  private draw(): void {
    const state = this.state;
    if (!state) return;
    // What you are typing survives the redraw (the spec comes back after every change).
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const typing = active && this.root.contains(active) && active.dataset.keep
      ? { keep: active.dataset.keep, value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const kept = [...this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-keep]")]
      .filter((input) => input.dataset.dirty === "1")
      .map((input) => [input.dataset.keep!, input.value] as const);

    const fresh = this.render(state);
    if (this.content) {
      const result = keepFrames(this.content, fresh);
      if (result === fresh) this.content.replaceWith(fresh);
      this.content = result;
    } else {
      this.root.append(fresh);
      this.content = fresh;
    }
    for (const [keep, value] of kept) {
      const input = this.content.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${keep}"]`);
      if (input) {
        input.value = value;
        input.dataset.dirty = "1";
      }
    }
    if (typing) {
      const input = this.content.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${typing.keep}"]`);
      if (input) {
        input.value = typing.value;
        input.focus();
        if (typing.start !== null && typing.end !== null) input.setSelectionRange?.(typing.start, typing.end);
      }
    }
  }

  private render(state: SpecState): HTMLElement {
    const panel = el("div", `spec-panel ${state.status}${state.wide ? " wide" : ""}`);
    panel.dataset.spec = state.id;
    panel.append(this.header(state));
    const body = el("div", "spec-body");
    const left = el("div", "spec-left");
    const right = el("div", "spec-right");
    left.append(this.preview(state));
    // A built one can be changed here too: Build it then makes a new version.
    if (state.status === "building") right.append(this.progress(state));
    else right.append(this.fields(state));
    if (state.status === "done") right.append(this.progress(state));
    left.append(this.conversation(state));
    body.append(left, right);
    panel.append(body, this.foot(state));
    return panel;
  }

  // MARK: Header

  private header(state: SpecState): HTMLElement {
    const head = el("div", "spec-head");
    const mark = el("span", "spec-mark");
    mark.innerHTML = "<i></i>";
    const titles = el("div", "spec-titles");
    const title = el("div", "spec-title");
    const words = state.status === "done" ? state.name
      : state.status === "building" ? `Building ${state.name}`
      : state.existing ? "Add to another bot" : "New component";
    title.textContent = words;
    if (state.status === "draft" && !state.existing) title.append(el("code", "spec-name-tag", state.name));
    const subtitle = el("div", "spec-subtitle", state.status === "done"
      ? (state.bots.some((b) => b.on) ? `Added to ${state.bots.filter((b) => b.on).map((b) => b.name).join(", ")}` : "In the library")
      : `Maintainer · ${state.from}`);
    titles.append(title, subtitle);
    head.append(mark, titles);
    if (state.status === "draft" && !state.existing) head.append(el("span", "spec-draft", `draft ${state.draft}`));
    head.append(
      button("spec-icon", state.wide ? icons.narrow : icons.expand, () => post({ type: "specWide", wide: !state.wide }), state.wide ? "Narrower" : "Wider"),
      button("spec-icon", icons.collapse, () => post({ type: "specClose" }), "Collapse to the chip"),
    );
    return head;
  }

  // MARK: Preview

  private preview(state: SpecState): HTMLElement {
    const block = el("section", "spec-block spec-preview");
    const head = el("div", "spec-block-head");
    head.append(el("span", "spec-label", state.status === "done" ? "Live" : "Preview"));
    head.append(el("span", "spec-grow"));
    const samples = this.samples(state);
    const chosen = this.chosenSample(state, samples);
    if (samples.length > 1) {
      const group = el("div", "spec-samples spec-seg");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Sample data");
      for (const sample of samples) {
        const tab = button(sample.label === chosen?.label ? "on" : "", "", () => {
          this.sample.set(state.id, sample.label);
          this.draw();
        });
        tab.textContent = sample.label;
        tab.setAttribute("aria-pressed", String(sample.label === chosen?.label));
        group.append(tab);
      }
      head.append(group);
    }
    block.append(head);
    const name = state.preview ?? "spec-preview";
    const info = state.preview ? state.components[state.preview] : plainInfo;
    const data = chosen?.data ?? "null";
    const card = componentElement(name, info ?? plainInfo, data, null, `spec/${state.id}/${chosen?.label ?? ""}`);
    if (card) {
      // The report flag is for components in the chat, not a draft.
      card.querySelector(".component-side")?.remove();
      block.append(card);
    }
    return block;
  }

  private samples(state: SpecState): { label: string; data: string }[] {
    return state.samples.length ? state.samples : [{ label: "Empty", data: "null" }];
  }

  private chosenSample(state: SpecState, samples: { label: string; data: string }[]): { label: string; data: string } | undefined {
    const picked = this.sample.get(state.id);
    // Done with a command (live data): the real run first, if there was one. Otherwise the
    // reply's own content, as it shows under the reply.
    const fallback = state.status === "done" && state.command ? samples.find((s) => s.label === "Test run") : undefined;
    const reply = samples.find((s) => s.label === "This reply") ?? samples.find((s) => s.label === "This page");
    return samples.find((s) => s.label === picked) ?? fallback ?? reply ?? samples[0];
  }

  // MARK: Fields

  private field(state: SpecState, key: string, label: string, content: HTMLElement | HTMLElement[]): HTMLElement {
    const by = state.origins[key] as SpecOrigin | undefined;
    const row = el("div", `spec-field${by === "user" ? " by-user" : by === "maintainer" ? " by-maintainer" : ""}`);
    row.append(el("div", "spec-key", label));
    const value = el("div", "spec-value");
    value.append(...(Array.isArray(content) ? content : [content]));
    // Maintainer's values only get its colour; yours say so too.
    if (by === "user") value.append(el("span", "spec-by user", "Edited by you"));
    row.append(value);
    return row;
  }

  private input(state: SpecState, key: string, value: string, placeholder: string, mono = false): HTMLInputElement {
    const input = el("input", `spec-input${mono ? " mono" : ""}`);
    input.value = value;
    input.placeholder = placeholder;
    input.dataset.key = key;
    input.dataset.keep = key;
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input.addEventListener("change", () => {
      input.dataset.dirty = "";
      if (input.value.trim() !== value.trim()) post({ type: "specEdit", id: state.id, key, value: input.value.trim() });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    return input;
  }

  private fields(state: SpecState): HTMLElement {
    const block = el("section", "spec-block spec-fields");
    const head = el("div", "spec-block-head");
    head.append(el("span", "spec-label", "Spec"));
    if (!state.existing) head.append(el("code", "spec-name-tag", state.name));
    block.append(head);

    if (!state.existing) {
      block.append(this.field(state, "name", "Name", this.input(state, "name", state.name, "short-english-name", true)));
      block.append(this.field(state, "about", "About", this.input(state, "about", state.about, "What it shows, in a sentence")));

      const data = el("div", "spec-data");
      for (const field of state.fields) {
        const chip = el("span", `spec-datum${field.by === "user" ? " by-user" : field.by === "maintainer" ? " by-maintainer" : ""}`);
        chip.append(document.createTextNode(field.name + " "), el("b", "", field.type));
        data.append(chip);
      }
      if (!state.fields.length) data.append(el("span", "spec-faint", "None yet"));
      const edit = this.input(state, "fields", state.fields.map((f) => `${f.name}: ${f.type}`).join(", "), "name: type, …", true);
      edit.classList.add("spec-fields-edit");
      block.append(this.field(state, "fields", "Data", [data, edit]));

      const command = this.input(state, "command", state.command ?? "", "Command that prints the data (optional)", true);
      const line = el("div", "spec-command");
      line.append(command);
      if (state.command) {
        line.append(button("spec-button small spec-test-run", `${icons.run}Test run`, () => {
          post({ type: "specTestRun", id: state.id, command: state.command ?? "", folder: state.folder });
        }));
      }
      const commandParts: HTMLElement[] = [line];
      if (state.testRun) commandParts.push(this.testRun(state));
      block.append(this.field(state, "command", "Command", commandParts));
      block.append(this.field(state, "folder", "Folder", el("code", "spec-folder", state.folder)));

      const refresh = el("div", "spec-refresh spec-seg");
      refresh.dataset.key = "refresh";
      refresh.setAttribute("role", "group");
      refresh.setAttribute("aria-label", "Refresh");
      for (const mode of ["shown", "interval", "manual"] as PinRefresh[]) {
        const option = button(mode === state.refresh ? "on" : "", "", () => post({ type: "specEdit", id: state.id, key: "refresh", value: mode }));
        option.textContent = refreshWords(mode, state.minutes);
        option.setAttribute("aria-pressed", String(mode === state.refresh));
        refresh.append(option);
      }
      block.append(this.field(state, "refresh", "Refresh", refresh));
    }

    const bots = el("div", "spec-bots");
    for (const bot of state.bots) {
      const chip = button(`spec-bot${bot.on ? " on" : ""}`, `${bot.on ? icons.check : ""}<span></span>`, () => {
        const next = state.bots.filter((b) => (b.name === bot.name ? !b.on : b.on)).map((b) => b.name);
        post({ type: "specEdit", id: state.id, key: "bots", value: next.join(", ") });
      });
      chip.querySelector("span")!.textContent = bot.name;
      chip.setAttribute("aria-pressed", String(bot.on));
      bots.append(chip);
    }
    block.append(this.field(state, "bots", "Bots", bots));

    if (!state.existing && state.similar) {
      const similar = el("div", "spec-similar");
      const name = el("code", "", state.similar);
      const about = el("span", "spec-faint", state.similarAbout ? ` ${state.similarAbout}` : "");
      const choice = el("div", "spec-seg");
      const fresh = button(state.reuse ? "new" : "new on", "", () => post({ type: "specEdit", id: state.id, key: "reuse", value: "false" }));
      fresh.textContent = "A new one";
      const reuse = button(state.reuse ? "reuse on" : "reuse", "", () => post({ type: "specEdit", id: state.id, key: "reuse", value: "true" }));
      reuse.textContent = `Reuse ${state.similar}`;
      choice.append(fresh, reuse);
      similar.append(name, about, choice);
      block.append(this.field(state, "reuse", "Similar", similar));
    }
    return block;
  }

  /** The test run: the allow question (exact command and folder), running, or what it printed. */
  private testRun(state: SpecState): HTMLElement {
    const run = state.testRun!;
    const box = el("div", `spec-test ${run.status}`);
    if (run.status === "approve") {
      const ask = el("div", "command-approve");
      ask.append(el("div", "", "Test run runs this command in"));
      ask.append(el("code", "command-folder", run.folder));
      ask.append(el("pre", "command-full", run.command));
      const actions = el("div", "command-actions");
      const allow = button("primary command-allow", "Allow and run", () => {
        allow.disabled = true;
        post({ type: "specTestRun", id: state.id, command: run.command, folder: run.folder, approve: true });
      });
      actions.append(allow, el("span", "command-note", "Remembered for this command in this folder."));
      ask.append(actions);
      box.append(ask);
    } else if (run.status === "running" || run.status === "idle") {
      box.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Running…</span>`;
    } else if (run.status === "failed") {
      const problem = el("div", "command-error");
      problem.setAttribute("role", "alert");
      problem.append(el("strong", "", "The command failed"), el("pre", "", run.error ?? ""));
      box.append(problem);
    } else {
      const check = el("div", `spec-check${run.matches === false ? " off" : ""}`);
      check.innerHTML = run.matches === false ? "" : icons.check;
      check.append(document.createTextNode(`${run.ranAt ? `Ran ${run.ranAt}` : "Ran"} · ${run.matches === false ? "output does not match the fields" : "output matches the fields"}`));
      box.append(check, el("pre", "spec-output", (run.output ?? "").slice(0, 600)));
    }
    return box;
  }

  // MARK: Building and done

  private progress(state: SpecState): HTMLElement {
    const block = el("section", "spec-block spec-progress");
    if (state.steps?.length) {
      const list = el("div", "spec-steps");
      for (const step of state.steps) {
        const line = el("div", `spec-step ${step.state}`);
        const dot = el("span", "spec-dot");
        if (step.state === "done") dot.innerHTML = icons.check;
        line.append(dot, el("span", "", step.label));
        list.append(line);
      }
      block.append(list);
    }
    if (state.status === "done") {
      const on = state.bots.filter((b) => b.on).map((b) => b.name);
      block.append(el("div", "spec-added", on.length ? `Added to ${on.join(", ")}` : `${state.name} is in the library`));
    } else {
      block.append(el("div", "spec-faint", "Maintainer is building it. You can collapse this and keep chatting; it shows under the reply once it is added."));
    }
    return block;
  }

  // MARK: Conversation

  private conversation(state: SpecState): HTMLElement {
    const block = el("section", "spec-conv");
    for (const line of state.conversation) {
      const row = el("div", `spec-line ${line.kind}`);
      if (line.kind === "maintainer") {
        const mark = el("span", "spec-mark small");
        mark.innerHTML = "<i></i>";
        row.append(mark);
      }
      row.append(el("div", "spec-words", line.text));
      block.append(row);
    }
    if (state.status !== "building") {
      for (const question of state.questions) {
        const box = el("div", "spec-question");
        box.append(el("div", "spec-question-text", question.text));
        const answers = el("div", "spec-answers");
        question.options.forEach((option, index) => {
          const suggested = index === question.suggested;
          const answer = button(`spec-answer${suggested ? " suggested" : ""}`, "", () => post({ type: "specAnswer", id: state.id, question: question.id, option: index }));
          answer.textContent = suggested ? `${option.label} · suggested` : option.label;
          answers.append(answer);
        });
        box.append(answers);
        block.append(box);
      }
    }
    if (!block.childElementCount) block.append(el("div", "spec-faint", "Maintainer fills in what it can tell from the reply and asks only what it can't."));
    return block;
  }

  // MARK: Foot

  private foot(state: SpecState): HTMLElement {
    const foot = el("div", "spec-foot");
    const say = el("div", "spec-say");
    const box = el("textarea");
    box.rows = 1;
    box.dataset.keep = "say";
    box.placeholder = state.status === "done" ? "Ask for changes…" : "Anything to add? Reply to Maintainer…";
    box.setAttribute("aria-label", box.placeholder);
    const send = button("spec-send", icons.send, () => {
      const text = box.value.trim();
      if (!text) return;
      box.value = "";
      box.dataset.dirty = "";
      post({ type: "specSay", id: state.id, text });
    }, "Send to Maintainer");
    box.addEventListener("input", () => { box.dataset.dirty = "1"; });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send.click();
      }
    });
    say.append(box, send);
    if (!state.existing) foot.append(say);
    if (state.status !== "building") {
      const done = state.status === "done";
      const actions = el("div", "spec-actions");
      if (done) actions.append(button("spec-button ghost", "Hide", () => post({ type: "specClose" })));
      else actions.append(button("spec-button ghost spec-cancel", "Cancel", () => post({ type: "specCancel", id: state.id })));
      actions.append(el("span", "spec-grow"));
      if (state.questions.length) actions.append(el("span", "spec-faint spec-note", "Open questions use the suggested answers"));
      const build = button("spec-button primary spec-build", "", () => post({ type: "specBuild", id: state.id }));
      build.textContent = state.existing ? "Add to bots" : done ? "Build a new version" : "Build it";
      build.disabled = !state.bots.some((b) => b.on);
      actions.append(build);
      foot.append(actions);
    } else {
      const legend = el("div", "spec-actions");
      legend.append(el("span", "spec-grow"));
      legend.append(button("spec-button ghost", "Hide", () => post({ type: "specClose" })));
      foot.append(legend);
    }
    if (state.status !== "building" && !state.existing) {
      const legend = el("div", "spec-legend");
      legend.innerHTML = `<span><span class="spec-by user">blue</span> you</span><span><span class="spec-by maintainer">purple</span> Maintainer</span>`;
      foot.append(legend);
    }
    return foot;
  }
}
