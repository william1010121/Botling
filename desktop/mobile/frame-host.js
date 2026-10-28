// Botling Web's component/card frame host (src/renderer/web-pages.ts). Served with a CSP whose
// `sandbox allow-scripts` keeps it an opaque origin wherever it is loaded. Takes one page, from its
// parent only, and writes it into itself (the page carries the desktop's component/card CSP).
(() => {
  let done = false;
  addEventListener('message', (event) => {
    const data = event.data;
    if (done || event.source !== parent || parent === window || !data || data.botlingHost !== 'page' || typeof data.html !== 'string') return;
    done = true;
    document.open();
    document.write(data.html);
    document.close();
  });
})();
