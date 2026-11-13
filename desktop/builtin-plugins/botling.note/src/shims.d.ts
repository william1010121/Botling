// Text and base64 imports, as build.json's loaders bundle them (KaTeX's stylesheet and fonts, src/katex-style.ts).
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.woff2" {
  const base64: string;
  export default base64;
}
