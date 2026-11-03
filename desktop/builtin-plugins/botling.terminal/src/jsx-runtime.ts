// What the JSX of ui.tsx compiles to ("react/jsx-runtime", aliased to this file in build.json): Preact's elements.
import { Fragment, h } from "preact";

export { Fragment };
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown) {
  return h(type, key === undefined ? props : { ...props, key });
}
export const jsxs = jsx;
