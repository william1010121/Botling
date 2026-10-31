// A small syntax highlighter for diff lines: one line at a time (a diff shows pieces of files, so no
// state carries from one line to the next), no dependency. It marks comments, strings, numbers and
// keywords for the common languages; an unknown file type is left plain.

export type TokenKind = "" | "kw" | "str" | "num" | "com";
export interface Token { text: string; kind: TokenKind }

interface Language { line: string[]; block: boolean; keywords: Set<string>; quotes: string }

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));
const JS = words("as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield");
const PY = words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self");
const SWIFT = words("actor as async await break case catch class continue default defer do else enum extension false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat return self static struct subscript super switch throw throws true try typealias var where while");
const RUST = words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while");
const GO = words("break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var");
const CLIKE = words("abstract auto bool break case catch char class const continue default delete do double else enum explicit extern false final finally float for friend goto if import inline int interface long namespace new null nullptr operator override package private protected public register return short signed sizeof static struct switch template this throw throws true try typedef typename union unsigned using virtual void volatile while");
const SHELL = words("case do done elif else esac exit export fi for function if in local return select then until while echo cd");
const CSS = words("important");
const JSON_WORDS = words("true false null");

const slash = { line: ["//"], block: true };
const LANGUAGES: Record<string, Language> = {
  js: { ...slash, keywords: JS, quotes: "\"'`" },
  py: { line: ["#"], block: false, keywords: PY, quotes: "\"'" },
  swift: { ...slash, keywords: SWIFT, quotes: "\"" },
  rust: { ...slash, keywords: RUST, quotes: "\"" },
  go: { ...slash, keywords: GO, quotes: "\"'`" },
  clike: { ...slash, keywords: CLIKE, quotes: "\"'" },
  shell: { line: ["#"], block: false, keywords: SHELL, quotes: "\"'" },
  css: { line: [], block: true, keywords: CSS, quotes: "\"'" },
  json: { line: [], block: false, keywords: JSON_WORDS, quotes: "\"" },
  yaml: { line: ["#"], block: false, keywords: JSON_WORDS, quotes: "\"'" },
};
const BY_EXTENSION: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  py: "py", swift: "swift", rs: "rust", go: "go",
  java: "clike", kt: "clike", c: "clike", h: "clike", cc: "clike", cpp: "clike", hpp: "clike", cs: "clike", m: "clike", mm: "clike", php: "clike",
  sh: "shell", bash: "shell", zsh: "shell", css: "css", scss: "css", json: "json", yml: "yaml", yaml: "yaml", toml: "yaml",
};

/** The language a path is highlighted as, or null. */
export function languageOf(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (/^(Dockerfile|Makefile)$/.test(name)) return "shell";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

const NUMBER = /^(?:0x[0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w])/i;
const WORD = /^[A-Za-z_$][\w$]*/;

/** One line as tokens; joining their text gives the line back. */
export function tokenize(line: string, language: string | null): Token[] {
  const lang = language ? LANGUAGES[language] : undefined;
  if (!lang || line.length > 1000) return [{ text: line, kind: "" }];
  const out: Token[] = [];
  let plain = "";
  const flush = () => { if (plain) { out.push({ text: plain, kind: "" }); plain = ""; } };
  const push = (text: string, kind: TokenKind) => { flush(); out.push({ text, kind }); };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (lang.line.some((marker) => rest.startsWith(marker))) { push(rest, "com"); break; }
    if (lang.block && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const text = end < 0 ? rest : rest.slice(0, end + 2);
      push(text, "com"); i += text.length; continue;
    }
    // A block comment's middle line: ` * text`.
    if (lang.block && i === 0 && /^\s*\*+(\s|\/|$)/.test(rest)) { push(rest, "com"); break; }
    const ch = line[i];
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const text = line.slice(i, Math.min(j + 1, line.length));
      push(text, "str"); i += text.length; continue;
    }
    if (/\d/.test(ch) && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      const match = NUMBER.exec(rest);
      if (match) { push(match[0], "num"); i += match[0].length; continue; }
    }
    const word = WORD.exec(rest);
    if (word) {
      if (lang.keywords.has(word[0])) push(word[0], "kw"); else plain += word[0];
      i += word[0].length; continue;
    }
    plain += ch; i++;
  }
  flush();
  return out.length ? out : [{ text: line, kind: "" }];
}
