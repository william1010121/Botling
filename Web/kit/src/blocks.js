// The kit's blocks: Card, Stat, Ring, Bar, Spark, List, Chips, Button, Choices, Empty. Each is a
// Preact function component drawing plain elements with ccb- classes (kit.css styles them with
// the app's tokens). Every block takes `tone`, `class`, `style` and any other attribute for its
// outer element; most take `size` ("s" | "m" | "l"), `compact` and `icon` too.
import { h } from "preact";
import { useState } from "preact/hooks";

// ---- shared bits ------------------------------------------------------------------------------

const tones = {
  ok: "ok", good: "ok", success: "ok", green: "ok",
  warn: "warn", warning: "warn", mid: "warn", orange: "warn",
  bad: "bad", error: "bad", danger: "bad", red: "bad",
  info: "info", accent: "info", blue: "info",
  neutral: "neutral", muted: "neutral", none: "neutral",
};

/** "ok", "warn" or "bad" for a value against its max: under `warn` (0.6) of it ok, under `bad` (0.85) warn, else bad; `invert` when low is bad. */
export function toneFor(value, { max = 100, warn = 0.6, bad = 0.85, invert = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(max > 0)) return "neutral";
  let ratio = n / max;
  if (invert) ratio = 1 - ratio;
  return ratio < warn ? "ok" : ratio < bad ? "warn" : "bad";
}

const toneClass = (tone, value, max) => {
  if (tone === "auto") return "ccb-tone-" + toneFor(value, { max });
  const known = tones[String(tone || "").toLowerCase()];
  return known ? "ccb-tone-" + known : "";
};
const cx = (...names) => names.filter(Boolean).join(" ");
const sizes = { s: "s", small: "s", m: "m", medium: "m", l: "l", large: "l" };
const sizeClass = (size) => (sizes[size] ? "ccb-size-" + sizes[size] : "");
/** The outer element's classes: the block's own, its tone/size/compact and the caller's class. */
const outer = (base, { tone, size, compact, class: extra, className }, value, max) =>
  cx(base, toneClass(tone, value, max), sizeClass(size), compact && "ccb-compact", extra, className);
const icon = (glyph, cls = "ccb-icon") => (glyph == null || glyph === false || glyph === "" ? null : h("span", { class: cls, "aria-hidden": "true" }, glyph));
const num = (v) => { const n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const answer = (value) => { const ccb = window.ccb; if (ccb && typeof ccb.answer === "function") return ccb.answer(value); return undefined; };

// ---- Card -------------------------------------------------------------------------------------

/**
 * The component's card: an optional header (icon, title, subtitle, actions on the right), the
 * body (children) and an optional footer. It draws no frame of its own (the chat bubble or Board
 * tile frames it) unless `framed`, which gives a bordered box for cards inside a card.
 */
export function Card(props) {
  const { title, subtitle, icon: glyph, actions, footer, framed, children, tone, size, compact, class: _c, className: _n, ...rest } = props;
  const head = title != null || subtitle != null || glyph != null || actions != null;
  return h("section", { ...rest, class: outer(cx("ccb-card", framed && "ccb-card--framed"), props) },
    head && h("header", { class: "ccb-card__head" },
      icon(glyph, "ccb-card__icon ccb-icon"),
      h("div", { class: "ccb-card__titles" },
        title != null && h("div", { class: "ccb-card__title" }, title),
        subtitle != null && h("div", { class: "ccb-card__subtitle" }, subtitle)),
      actions != null && h("div", { class: "ccb-card__actions" }, actions)),
    h("div", { class: "ccb-card__body" }, children),
    footer != null && h("footer", { class: "ccb-card__foot" }, footer));
}

// ---- Stat -------------------------------------------------------------------------------------

/**
 * One number with its label: `label`, `value`, `unit`, `delta` (a number or "+3%"; up is good
 * unless `invert`), `detail` under it. `tone` colours the value ("auto" from value/max).
 */
export function Stat(props) {
  const { label, value, unit, delta, detail, invert, max = 100, framed, icon: glyph, tone, size, compact, class: _c, className: _n, children, ...rest } = props;
  let deltaView = null;
  if (delta != null && delta !== "") {
    const n = num(delta);
    const text = String(delta);
    const up = n != null ? n > 0 : text.trim().startsWith("+");
    const down = n != null ? n < 0 : /^[-−]/.test(text.trim());
    const good = invert ? down : up;
    const shown = n != null ? (n > 0 ? "▲ " : n < 0 ? "▼ " : "") + Math.abs(n).toLocaleString() : text;
    deltaView = h("span", { class: cx("ccb-stat__delta", up && "ccb-up", down && "ccb-down", (up || down) && (good ? "ccb-good" : "ccb-bad")) }, shown);
  }
  return h("div", { ...rest, class: outer(cx("ccb-stat", framed && "ccb-stat--framed"), props, num(value), max) },
    (label != null || glyph != null) && h("div", { class: "ccb-stat__label" }, icon(glyph), label),
    h("div", { class: "ccb-stat__line" },
      h("span", { class: "ccb-stat__value" }, value == null || value === "" ? "–" : value, unit != null && h("small", { class: "ccb-stat__unit" }, unit)),
      deltaView),
    detail != null && h("div", { class: "ccb-stat__detail" }, detail),
    children);
}

// ---- Ring -------------------------------------------------------------------------------------

const ringSizes = { s: 56, m: 84, l: 120 };
/**
 * A round gauge: `value` of `max` (100), the `label` in the middle (the percent when not given),
 * a `caption` under it, `thickness` of the ring (10 of 100). `size` "s" | "m" | "l" or pixels.
 */
export function Ring(props) {
  const { value, max = 100, label, caption, thickness = 10, tone, size, compact, class: _c, className: _n, style, children, ...rest } = props;
  const n = num(value);
  const fraction = n == null || !(max > 0) ? 0 : clamp(n / max, 0, 1);
  const r = 50 - thickness / 2;
  const around = 2 * Math.PI * r;
  const px = typeof size === "number" ? size : null;
  const sized = px ? { "--ccb-ring-size": px + "px" } : null;
  const styles = typeof style === "string" ? (sized ? `--ccb-ring-size:${px}px;${style}` : style) : { ...sized, ...style };
  return h("div", {
    role: "meter", "aria-valuenow": n == null ? undefined : n, "aria-valuemin": 0, "aria-valuemax": max,
    ...rest, class: outer("ccb-ring", { ...props, size: px ? null : size }, n, max), style: styles,
  },
  h("svg", { viewBox: "0 0 100 100", class: "ccb-ring__svg", "aria-hidden": "true" },
    h("circle", { class: "ccb-ring__track", cx: 50, cy: 50, r, "stroke-width": thickness }),
    h("circle", { class: "ccb-ring__arc", cx: 50, cy: 50, r, "stroke-width": thickness, "stroke-dasharray": `${(around * fraction).toFixed(2)} ${around.toFixed(2)}`, transform: "rotate(-90 50 50)" })),
  h("div", { class: "ccb-ring__center" },
    h("span", { class: "ccb-ring__label" }, label != null ? label : n == null ? "–" : Math.round(fraction * 100) + "%"),
    caption != null && h("span", { class: "ccb-ring__caption" }, caption)),
  children);
}

// ---- Bar --------------------------------------------------------------------------------------

function meter(item, tone, max, unit, key) {
  const n = num(item.value);
  const top = num(item.max) ?? max;
  const fraction = n == null || !(top > 0) ? 0 : clamp(n / top, 0, 1);
  const shown = item.valueText != null ? item.valueText : n == null ? "–" : unit != null ? n.toLocaleString() + unit : Math.round(fraction * 100) + "%";
  return h("div", { key, class: cx("ccb-bar", toneClass(item.tone ?? tone, n, top)) },
    (item.label != null || item.valueText !== "") && h("div", { class: "ccb-bar__head" },
      h("span", { class: "ccb-bar__label" }, item.label),
      h("span", { class: "ccb-bar__value" }, shown)),
    h("div", { class: "ccb-bar__track", role: "meter", "aria-label": item.label == null ? undefined : String(item.label), "aria-valuenow": n == null ? undefined : n, "aria-valuemin": 0, "aria-valuemax": top },
      h("div", { class: "ccb-bar__fill", style: { width: (fraction * 100).toFixed(1).replace(/\.0$/, "") + "%" } })));
}

/**
 * Bars. One meter: `value` of `max` with a `label` (and `unit`, or `valueText`, for the number at
 * its right; the percent otherwise). `items` of {label, value, max?, tone?, valueText?}: one meter
 * each. `items` of plain numbers (or `columns`): a small column chart, `height` in pixels.
 * `max` is 100 when every value fits in 0–100, else the largest. `tone="auto"`: each by value/max.
 */
export function Bar(props) {
  const { value, max: given, label, unit, valueText, items, columns, height, tone, size, compact, class: _c, className: _n, style, ...rest } = props;
  const list = Array.isArray(items) ? items.map((item) => (item != null && typeof item === "object" ? item : { value: item })) : null;
  const values = (list || [{ value }]).map((item) => num(item.value)).filter((n) => n != null);
  const max = num(given) ?? (values.every((n) => n >= 0 && n <= 100) ? 100 : Math.max(...values, 1));
  const asColumns = list && (columns || (Array.isArray(items) && items.every((item) => typeof item === "number" || typeof item === "string")));
  if (asColumns) {
    const sized = height ? { "--ccb-bars-h": height + "px" } : null;
    return h("div", { ...rest, class: outer("ccb-bar ccb-bar--columns", { ...props, tone: null }), style: typeof style === "string" ? style : { ...sized, ...style }, role: "img", "aria-label": label == null ? undefined : String(label) },
      list.map((item, i) => {
        const n = num(item.value);
        const fraction = n == null || !(max > 0) ? 0 : clamp(n / max, 0, 1);
        return h("div", { key: i, class: cx("ccb-bar__col", toneClass(item.tone ?? tone, n, max)), title: item.label != null ? `${item.label}: ${item.value}` : String(item.value), style: { height: (fraction * 100).toFixed(1) + "%" } });
      }));
  }
  if (list) {
    return h("div", { ...rest, class: outer("ccb-bars", { ...props, tone: null }), style }, list.map((item, i) => meter(item, tone, max, unit, i)));
  }
  const one = meter({ value, label, valueText }, tone, max, unit);
  return h("div", { ...rest, class: cx(one.props.class, sizeClass(size), compact && "ccb-compact", props.class, props.className), style }, one.props.children);
}

// ---- Spark ------------------------------------------------------------------------------------

/** A sparkline of `values` (numbers): a line with a soft fill under it (`fill={false}` for none) and a dot at the last value. `height` in pixels (40), `min`/`max` to fix the scale. */
export function Spark(props) {
  const { values, min, max, fill = true, dot = true, height, label, tone, size, compact, class: _c, className: _n, style, ...rest } = props;
  const points = (Array.isArray(values) ? values : []).map(num).filter((n) => n != null);
  const lo = num(min) ?? Math.min(...points);
  const hi = num(max) ?? Math.max(...points);
  const span = hi - lo || 1;
  const xy = points.map((n, i) => [points.length < 2 ? 50 : (i / (points.length - 1)) * 100, 100 - ((n - lo) / span) * 100]);
  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const last = xy[xy.length - 1];
  const sized = height ? { "--ccb-spark-h": height + "px" } : null;
  return h("div", { role: "img", "aria-label": label == null ? undefined : String(label), ...rest, class: outer("ccb-spark", props), style: typeof style === "string" ? style : { ...sized, ...style } },
    points.length > 0 && h("svg", { class: "ccb-spark__svg", viewBox: "0 -4 100 108", preserveAspectRatio: "none", "aria-hidden": "true" },
      fill && points.length > 1 && h("polygon", { class: "ccb-spark__area", points: `0,104 ${line} 100,104` }),
      h("polyline", { class: "ccb-spark__line", points: line })),
    dot && last && h("span", { class: "ccb-spark__dot", style: { left: last[0] + "%", top: ((last[1] + 4) / 108 * 100).toFixed(2) + "%" } }));
}

// ---- List -------------------------------------------------------------------------------------

/**
 * Rows of {title (or label), detail, value, icon, tone, onClick}: the title and a muted detail on
 * the left, the value on the right. `max` shows that many and "+N more"; `empty` is the text when
 * there are none. A row with onClick is a button.
 */
export function List(props) {
  const { items, max, empty = "Nothing here", more = "more", tone, size, compact, class: _c, className: _n, ...rest } = props;
  const rows = (Array.isArray(items) ? items : []).map((item) => (item != null && typeof item === "object" ? item : { title: item }));
  if (!rows.length) return h(Empty, { title: empty, compact: true, class: cx("ccb-list--empty", props.class, props.className) });
  const shown = max > 0 ? rows.slice(0, max) : rows;
  return h("ul", { ...rest, class: outer("ccb-list", props) },
    shown.map((item, i) => {
      const inner = [
        item.icon != null && h("span", { class: "ccb-list__icon", "aria-hidden": "true" }, item.icon),
        h("span", { class: "ccb-list__main" },
          h("span", { class: "ccb-list__title" }, item.title ?? item.label),
          item.detail != null && h("span", { class: "ccb-list__detail" }, item.detail)),
        item.value != null && h("span", { class: "ccb-list__value" }, item.value),
      ];
      const rowClass = cx("ccb-list__row", toneClass(item.tone ?? tone));
      return typeof item.onClick === "function"
        ? h("li", { key: item.key ?? i, class: rowClass }, h("button", { type: "button", class: "ccb-list__button", onClick: () => item.onClick(item, i) }, inner))
        : h("li", { key: item.key ?? i, class: rowClass }, inner);
    }),
    shown.length < rows.length && h("li", { class: "ccb-list__more" }, `+${rows.length - shown.length} ${more}`));
}

// ---- Chips ------------------------------------------------------------------------------------

/** Small labels: `items` of text or {label, tone, icon, active}. With `onPick(item, index)` each is a button. */
export function Chips(props) {
  const { items, onPick, tone, size, compact, class: _c, className: _n, ...rest } = props;
  const list = (Array.isArray(items) ? items : []).map((item) => (item != null && typeof item === "object" ? item : { label: item }));
  return h("div", { ...rest, class: outer("ccb-chips", { ...props, tone: null }) },
    list.map((item, i) => {
      const cls = cx("ccb-chip", toneClass(item.tone ?? tone), item.active && "is-active");
      const inner = [icon(item.icon), h("span", { class: "ccb-chip__label" }, item.label)];
      return typeof onPick === "function"
        ? h("button", { key: i, type: "button", class: cls, "aria-pressed": item.active ? "true" : undefined, onClick: () => onPick(item, i) }, inner)
        : h("span", { key: i, class: cls }, inner);
    }));
}

// ---- Button -----------------------------------------------------------------------------------

const looks = { primary: "primary", danger: "danger", bad: "danger", error: "danger", ghost: "ghost", plain: "ghost" };
/** A button like the app's: `tone` "default" | "primary" | "danger" | "ghost", `size`, `icon`, `full` (whole width), `disabled`, `onClick`. */
export function Button(props) {
  const { tone, size, compact, icon: glyph, full, type = "button", children, class: extra, className, ...rest } = props;
  const look = looks[String(tone || "").toLowerCase()] || "default";
  return h("button", { type, ...rest, class: cx("ccb-button", "ccb-button--" + look, look === "default" && toneClass(tone), sizeClass(size), compact && "ccb-compact", full && "ccb-button--full", extra, className) },
    icon(glyph), children != null && h("span", { class: "ccb-button__label" }, children));
}

// ---- Choices ----------------------------------------------------------------------------------

/**
 * The multiple-choice question of the app's choices card: `options` (text or {label, description}),
 * one button each; `other` (true or its placeholder text) adds a field for a typed answer. A pick
 * answers the bot with its index (ccb.answer(i)), a typed answer with its text; then it locks.
 * `chosen` / `answer` show an earlier answer. `onPick(index, option)` / `onOther(text)` replace
 * the answering.
 */
export function Choices(props) {
  const { options, chosen = null, answer: given = null, other, sendLabel = "Send", answeredLabel = "Your answer", onPick, onOther, disabled, tone, size, compact, class: _c, className: _n, ...rest } = props;
  const [picked, setPicked] = useState(Number.isInteger(chosen) ? chosen : null);
  const [typed, setTyped] = useState(given == null ? null : String(given));
  const [draft, setDraft] = useState("");
  const locked = !!disabled || picked != null || typed != null;
  const list = (Array.isArray(options) ? options : []).map((option) => (option != null && typeof option === "object" ? option : { label: option }));
  const pick = (i) => {
    if (locked) return;
    setPicked(i);
    if (typeof onPick === "function") onPick(i, list[i]); else answer(i);
  };
  const send = () => {
    const text = draft.trim();
    if (locked || !text) return;
    setTyped(text);
    if (typeof onOther === "function") onOther(text); else answer(text);
  };
  return h("div", { ...rest, class: outer(cx("ccb-choices", locked && "is-locked"), props) },
    list.map((option, i) => h("button", {
      key: i, type: "button", class: cx("ccb-choice", picked === i && "is-chosen", locked && picked !== i && "is-dim"),
      disabled: locked, "aria-pressed": picked === i ? "true" : undefined, onClick: () => pick(i),
    },
    h("span", { class: "ccb-choice__label" }, option.label),
    (option.description ?? option.detail) != null && h("span", { class: "ccb-choice__detail" }, option.description ?? option.detail),
    picked === i && h("span", { class: "ccb-choice__mark", "aria-hidden": "true" }, "✓"))),
    other && typed == null && h("div", { class: "ccb-choices__other" },
      h("input", {
        class: "ccb-choices__input", type: "text", value: draft, disabled: locked,
        placeholder: typeof other === "string" ? other : "Other (type your own)",
        onInput: (event) => setDraft(event.currentTarget.value),
        onKeyDown: (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); send(); } },
      }),
      h("button", { type: "button", class: "ccb-button ccb-button--primary ccb-choices__send", disabled: locked || !draft.trim(), onClick: send }, sendLabel)),
    typed != null && h("div", { class: "ccb-choices__answer" }, h("span", { class: "ccb-choices__answer-label" }, answeredLabel + ": "), typed));
}

// ---- Empty ------------------------------------------------------------------------------------

/** What a card shows with nothing to show: `icon`, `title`, `detail`, and an `action` (a Button) or children. */
export function Empty(props) {
  const { icon: glyph, title, detail, action, children, tone, size, compact, class: _c, className: _n, ...rest } = props;
  return h("div", { ...rest, class: outer("ccb-empty", props) },
    icon(glyph, "ccb-empty__icon ccb-icon"),
    title != null && h("div", { class: "ccb-empty__title" }, title),
    detail != null && h("div", { class: "ccb-empty__detail" }, detail),
    action, children);
}
