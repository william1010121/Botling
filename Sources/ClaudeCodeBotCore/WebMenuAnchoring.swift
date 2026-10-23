import WebKit

/// Geometry fallback for Gemini's portalled CDK submenus. The site owns normal positioning;
/// this only repairs a visible, expanded ARIA-controlled submenu detached from its trigger.
public enum WebMenuAnchoring {
    @MainActor
    public static func install(in configuration: WKWebViewConfiguration, host: String) {
        guard host == "gemini.google.com" else { return }
        configuration.userContentController.addUserScript(WKUserScript(
            source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true,
            in: WKContentWorld.world(name: "ccb-web-menu-anchoring")))
    }

    public static let source = #"""
    (() => {
      if (location.hostname !== 'gemini.google.com' || !('showPopover' in HTMLElement.prototype) ||
          !CSS.supports('selector(:popover-open)')) return;
      const repairs = new Map();
      let frame = 0;
      const properties = ['display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'margin', 'align-items', 'justify-content'];
      const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
      const sizes = new ResizeObserver(schedule);
      const observed = new Set();
      const watch = element => {
        if (!observed.has(element)) { observed.add(element); sizes.observe(element); }
      };
      const viewport = () => {
        const v = window.visualViewport;
        return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0,
          width: v?.width ?? innerWidth, height: v?.height ?? innerHeight };
      };
      const visible = (element, requireSize = true) => {
        if (!element.isConnected || element.closest('[hidden], [data-visible="false"]')) return false;
        const c = getComputedStyle(element), r = element.getBoundingClientRect();
        if (c.visibility !== 'visible') return false;
        for (let p = element; p; p = p.parentElement)
          if (getComputedStyle(p).display === 'none') return false;
        return !requireSize || (r.width > 0 && r.height > 0);
      };
      const restore = record => {
        if (record.placeholder) {
          const open = record.overlay.matches(':popover-open');
          if (open) record.overlay.hidePopover();
          if (record.placeholder.parentNode) record.placeholder.replaceWith(record.overlay);
          else record.parent.append(record.overlay);
          if (open && record.overlay.isConnected) record.overlay.showPopover();
        }
        for (const [key, value, priority] of record.original) {
          if (value) record.overlay.style.setProperty(key, value, priority);
          else record.overlay.style.removeProperty(key);
        }
      };
      const set = (element, key, value) => {
        if (element.style.getPropertyValue(key) !== value || element.style.getPropertyPriority(key) !== 'important')
          element.style.setProperty(key, value, 'important');
      };
      function update() {
        frame = 0;
        const active = new Set(), v = viewport(), epsilon = 1 / (devicePixelRatio || 1);
        // ARIA supplies the relationship even when the submenu lives in a separate portal.
        for (const anchor of document.querySelectorAll('[role="menuitem"][aria-haspopup][aria-expanded="true"][aria-controls]')) {
          if (!['true', 'menu'].includes(anchor.getAttribute('aria-haspopup')) || !visible(anchor)) continue;
          const menu = document.getElementById(anchor.getAttribute('aria-controls'));
          if (!menu?.matches('[role="menu"]') || !visible(menu, false)) continue;
          const overlay = menu.closest('.cdk-overlay-popover[popover]');
          if (!overlay || overlay.contains(anchor) || !overlay.matches(':popover-open')) continue;
          active.add(menu); watch(anchor); watch(menu);
          const a = anchor.getBoundingClientRect(), s = menu.getBoundingClientRect();
          const inside = s.left >= v.left - epsilon && s.top >= v.top - epsilon &&
            s.right <= v.left + v.width + epsilon && s.bottom <= v.top + v.height + epsilon;
          // CDK adds a small theme-dependent gap. Use the trigger's size, never page text
          // or fixed screen coordinates, to distinguish that gap from an orphan at (0,0).
          const adjacent = s.bottom > a.top && s.top < a.bottom &&
            (Math.abs(s.left - a.right) <= a.height || Math.abs(s.right - a.left) <= a.height);
          let record = repairs.get(menu);
          if (!record && inside && adjacent) continue;
          if (!record) {
            record = { overlay, original: properties.map(key => [key,
              overlay.style.getPropertyValue(key), overlay.style.getPropertyPriority(key)]) };
            repairs.set(menu, record);
            // WebKit can retain an origin/zero-sized render box for a nested top-layer
            // popover after dynamic positioning. Escape only that broken portal, preserving
            // the actual node/listeners and a placeholder for the site's original DOM.
            if (overlay.parentElement?.closest('[popover]')) {
              const focused = overlay.contains(document.activeElement) ? document.activeElement : null;
              record.parent = overlay.parentNode;
              record.placeholder = document.createComment('ccb-menu-portal');
              overlay.before(record.placeholder);
              overlay.hidePopover(); document.body.append(overlay); overlay.showPopover();
              focused?.focus({ preventScroll: true });
            }
            set(overlay, 'left', '0px'); set(overlay, 'top', '0px');
          }
          // Repair only this CDK bounding box; preserve the pane transform and menu styling.
          const style = { display: 'flex', position: 'fixed', right: 'auto', bottom: 'auto',
            width: 'max-content', height: 'max-content', margin: '0px',
            'align-items': 'flex-start', 'justify-content': 'flex-start' };
          for (const [key, value] of Object.entries(style)) set(overlay, key, value);
          const box = overlay.getBoundingClientRect(), m = menu.getBoundingClientRect();
          // CSS zoom (including inherited zoom) scales fixed top-layer coordinates.
          const scale = overlay.offsetWidth ? box.width / overlay.offsetWidth : 1;
          if (!(scale > 0) || !m.width || !m.height) continue;
          const rightSpace = v.left + v.width - a.right, leftSpace = a.left - v.left;
          const rtl = getComputedStyle(anchor).direction === 'rtl';
          const right = rtl ? leftSpace < m.width && rightSpace > leftSpace :
            rightSpace >= m.width || rightSpace >= leftSpace;
          const x = Math.max(v.left, Math.min(right ? a.right : a.left - m.width,
            v.left + Math.max(0, v.width - m.width)));
          const y = Math.max(v.top, Math.min(a.top, v.top + Math.max(0, v.height - m.height)));
          if (Math.abs(x - m.left) > epsilon)
            set(overlay, 'left', `${parseFloat(overlay.style.left) + (x - m.left) / scale}px`);
          if (Math.abs(y - m.top) > epsilon)
            set(overlay, 'top', `${parseFloat(overlay.style.top) + (y - m.top) / scale}px`);
        }
        for (const [menu, record] of repairs) {
          if (!active.has(menu)) { restore(record); repairs.delete(menu); }
        }
        for (const element of observed) {
          if (!element.isConnected || !visible(element)) { sizes.unobserve(element); observed.delete(element); }
        }
      }
      const start = () => {
        new MutationObserver(schedule).observe(document.documentElement, { subtree: true,
          childList: true, attributes: true,
          attributeFilter: ['aria-controls', 'aria-expanded', 'aria-haspopup', 'style', 'class', 'hidden', 'data-visible'] });
        document.addEventListener('toggle', schedule, true);
        document.addEventListener('scroll', schedule, { capture: true, passive: true });
        window.addEventListener('resize', schedule);
        window.visualViewport?.addEventListener('resize', schedule);
        window.visualViewport?.addEventListener('scroll', schedule);
        schedule();
      };
      if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    })();
    """#
}
