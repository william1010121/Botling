// reports/ bundles KaTeX's fonts with esbuild's base64 loader (reports/v2/core/katex-fonts.ts); the app-wide typecheck sees it here.
declare module "*.woff2" {
  const base64: string;
  export default base64;
}
