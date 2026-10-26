// The component kit, version 1 (README.md). Built into generated/kit.v1.js and put into a component's
// page when its template has <meta name="ccb-kit" content="1">: it runs after the page's `ccb`
// runtime and before the template, adds its stylesheet (the design tokens, then the blocks) at the
// top of <head>, and gives the template `ccb.kit` (also `window.ccbKit`).
import { h, render as draw, Fragment, Component, createContext, createRef, cloneElement, toChildArray } from "preact";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer, useContext, useId, useErrorBoundary } from "preact/hooks";
import htm from "htm";
import tokens from "../../src/tokens.css";
import blocksCSS from "./kit.css";
import { check } from "./check.js";
import { Boundary, ErrorCard, showError, watchErrors } from "./errors.js";
import { useData, useSize, useSurface } from "./hooks.js";
import { Card, Stat, Ring, Bar, Spark, List, Chips, Button, Choices, Empty, toneFor } from "./blocks.js";

const version = "1.0.0";

const style = document.createElement("style");
style.setAttribute("data-ccb-kit", version);
style.textContent = tokens + "\n" + blocksCSS;
document.head.prepend(style);
watchErrors();

const build = htm.bind(h);
/** htm's tagged template, checked first (check.js): a malformed one throws a MarkupError. */
function html(statics, ...fields) {
  check(statics, fields);
  return build(statics, ...fields);
}

/**
 * Draws `vnode` into `container` (#app, else #ccb-root, when not given), inside a boundary that
 * shows the error card in place of what throws while drawing.
 */
function render(vnode, container) {
  const target = container || document.getElementById("app") || document.getElementById("ccb-root");
  try {
    draw(h(Boundary, null, vnode), target);
  } catch (error) {
    showError(error);
  }
}

const kit = Object.freeze({
  version,
  h, html, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray,
  useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer, useContext, useId, useErrorBoundary,
  useData, useSize, useSurface,
  Card, Stat, Ring, Bar, Spark, List, Chips, Button, Choices, Empty, ErrorCard,
  toneFor, showError,
});

window.ccbKit = kit;
try {
  if (window.ccb && typeof window.ccb === "object" && !Object.isFrozen(window.ccb)) window.ccb.kit = kit;
} catch { /* a frozen ccb: window.ccbKit only */ }
