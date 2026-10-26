// A strict look over an html`…` template before htm reads it. htm itself is lenient: an unclosed
// tag, a close that does not match, or <Card> written without ${} gives a wrong or empty page and no
// error. These are the mistakes a template's author (often a bot) makes, so they become a
// MarkupError saying what is wrong and where, which the kit shows as its error card.

export class MarkupError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarkupError";
  }
}

const TEXT = 0, NAME = 1, TAG = 2, QUOTE = 3, COMMENT = 4;
const label = (value) => (typeof value === "function" ? value.displayName || value.name || "component" : String(value));
// Templates already found well formed (their strings array is the same object on every call),
// with no ${Component} close to compare: these are not looked at again.
const fine = new WeakSet();

/** Throws a MarkupError when the template `statics` (with `fields` between them) is not well formed. */
export function check(statics, fields) {
  if (fine.has(statics)) return;
  const stack = []; // open tags: {name, field}
  let mode = TEXT, quote = "", name = "", field = -1, closing = false, last = "", compared = false;
  const where = () => {
    const text = statics.reduce((all, part, i) => all + (i ? "${…}" : "") + part, "").trim().replace(/\s+/g, " ");
    return `\n\nIn: html\`${text.length > 160 ? text.slice(0, 157) + "…" : text}\``;
  };
  const fail = (message) => { throw new MarkupError(message + where()); };
  const shown = (tag) => (tag.field >= 0 ? `<\${${label(fields[tag.field])}}>` : `<${tag.name}>`);
  const closer = (tag) => (tag.field >= 0 ? `</\${${label(fields[tag.field])}}>` : `</${tag.name}>`);
  const end = (self) => {
    if (closing) {
      if (name === "/" || (name === "" && field < 0)) { // <//> or </>: closes whatever is open
        if (!stack.length) fail("A closing <//> has no open tag to close.");
        stack.pop();
        return;
      }
      const shut = closer({ name, field });
      const top = stack[stack.length - 1];
      if (!top) fail(`${shut} closes nothing: no tag is open there.`);
      if (field >= 0) compared = true;
      const same = top.field >= 0 ? field >= 0 && fields[field] === fields[top.field] : field < 0 && name === top.name;
      if (!same) fail(`${shut} closes ${shown(top)}, which is still open. Close ${shown(top)} first.`);
      stack.pop();
      return;
    }
    if (field < 0 && /^[A-Z]/.test(name)) fail(`<${name}> is not a component here: write <\${${name}}> … </\${${name}}> (or <\${${name}} … />).`);
    if (field < 0 && name === "") fail("A '<' starts a tag with no name. Write &lt; for a plain '<'.");
    if (!self) stack.push({ name, field });
  };
  for (let i = 0; i < statics.length; i++) {
    const s = statics[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (mode === TEXT) {
        if (c === "<") {
          if (s.startsWith("!--", j + 1)) { mode = COMMENT; j += 3; } else { mode = NAME; name = ""; field = -1; closing = false; last = ""; }
        }
      } else if (mode === COMMENT) {
        if (s.startsWith("-->", j)) { mode = TEXT; j += 2; }
      } else if (mode === NAME) {
        if (c === "/" && name === "" && field < 0) {
          if (closing) name = "/"; else closing = true;
        } else if (c === ">") { end(false); mode = TEXT; }
        else if (c === "/") { mode = TAG; last = "/"; }
        else if (/\s/.test(c)) { if (name || field >= 0) mode = TAG; }
        else name += c;
      } else if (mode === TAG) {
        if (c === '"' || c === "'") { quote = c; mode = QUOTE; }
        else if (c === ">") { end(last === "/"); mode = TEXT; }
        else if (!/\s/.test(c)) last = c;
      } else if (c === quote) { mode = TAG; last = c; }
    }
    if (i < statics.length - 1) { // a ${field} comes next
      if (mode === NAME && name === "" && field < 0) field = i;
      else if (mode === NAME) mode = TAG;
      if (mode === TAG) last = "${";
    }
  }
  if (mode === QUOTE) fail(`An attribute's quote (${quote}) is never closed.`);
  if (mode === NAME || mode === TAG) fail("A tag is not finished: it has no closing '>'.");
  if (mode === COMMENT) fail("A comment <!-- is never closed with -->.");
  if (stack.length) {
    const top = stack[stack.length - 1];
    fail(`${shown(top)} is never closed: end it with ${closer(top)} (or <//>), or write it as <… /> when it has no children. (htm has no void tags: write <br />, <img … />, <input … />.)`);
  }
  if (!compared) fine.add(statics);
}
