// KaTeX's stylesheet for the Note tab, from the app's own katex package (the one ccb-latex and the report renderer use),
// with its woff2 fonts inlined as data: URIs (reports/v2/core/katex-fonts.ts): the Note runs in a sandboxed mainTab frame,
// which loads no plugin stylesheet or font file, so the formulas must not depend on one. The woff / ttf fallbacks go.
import css from "katex/dist/katex.min.css";
import { katexFonts } from "../../../reports/v2/core/katex-fonts";

export default css
  .replace(/,url\(fonts\/[^)]*\.woff\) format\("woff"\)/g, "")
  .replace(/,url\(fonts\/[^)]*\.ttf\) format\("truetype"\)/g, "")
  .replace(/url\(fonts\/([^)]*)\.woff2\)/g, (whole: string, name: string) => (katexFonts[name] ? `url(data:font/woff2;base64,${katexFonts[name]})` : whole));
