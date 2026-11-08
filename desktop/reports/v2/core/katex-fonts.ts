// KaTeX's woff2 fonts as base64 (esbuild `.woff2` loader = base64; every bundler of reports/ sets it).
// math.ts inlines only the ones a page's math uses.
import f0 from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2';
import f1 from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2';
import f2 from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2';
import f3 from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2';
import f4 from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2';
import f5 from 'katex/dist/fonts/KaTeX_Main-Bold.woff2';
import f6 from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2';
import f7 from 'katex/dist/fonts/KaTeX_Main-Italic.woff2';
import f8 from 'katex/dist/fonts/KaTeX_Main-Regular.woff2';
import f9 from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2';
import f10 from 'katex/dist/fonts/KaTeX_Math-Italic.woff2';
import f11 from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2';
import f12 from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2';
import f13 from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2';
import f14 from 'katex/dist/fonts/KaTeX_Script-Regular.woff2';
import f15 from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2';
import f16 from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2';
import f17 from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2';
import f18 from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2';
import f19 from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2';
export const katexFonts: Record<string, string> = {
  'KaTeX_AMS-Regular': f0,
  'KaTeX_Caligraphic-Bold': f1,
  'KaTeX_Caligraphic-Regular': f2,
  'KaTeX_Fraktur-Bold': f3,
  'KaTeX_Fraktur-Regular': f4,
  'KaTeX_Main-Bold': f5,
  'KaTeX_Main-BoldItalic': f6,
  'KaTeX_Main-Italic': f7,
  'KaTeX_Main-Regular': f8,
  'KaTeX_Math-BoldItalic': f9,
  'KaTeX_Math-Italic': f10,
  'KaTeX_SansSerif-Bold': f11,
  'KaTeX_SansSerif-Italic': f12,
  'KaTeX_SansSerif-Regular': f13,
  'KaTeX_Script-Regular': f14,
  'KaTeX_Size1-Regular': f15,
  'KaTeX_Size2-Regular': f16,
  'KaTeX_Size3-Regular': f17,
  'KaTeX_Size4-Regular': f18,
  'KaTeX_Typewriter-Regular': f19,
};
