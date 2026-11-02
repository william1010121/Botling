// Preact comes from Botling's own copy (Web/kit/vendor) at build time, which has no types; the usage blocks use only these.
declare module "preact" {
  export function h(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  export function render(vnode: unknown, parent: Element): void;
  export const Fragment: unknown;
}
declare module "preact/hooks";
declare module "*.css" {
  const text: string;
  export default text;
}
