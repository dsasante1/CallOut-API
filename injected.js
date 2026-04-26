(function () {
  if (window.__apiOverlayActive) return;
  window.__apiOverlayActive = true;

  let requestId = 0;
  let lastInteractedEl = null;
  let lastInteractTime = 0;

  // ── Track the last element the user touched/clicked ──────────────────────
  ['mousedown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, e => {
      lastInteractedEl = e.target;
      lastInteractTime = Date.now();
    }, { capture: true, passive: true });
  });

  function getInteractedElement() {
    // Only associate if interaction happened within 800 ms
    return (Date.now() - lastInteractTime < 800) ? lastInteractedEl : null;
  }

  // ── Build a unique CSS selector for any element ───────────────────────────
  function uniqueSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      const parent = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function elementInfo(el) {
    if (!el) return null;
    return {
      selector: uniqueSelector(el),
      label: (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName)
               .toString().trim().slice(0, 60)
    };
  }

  function emit(data) {
    window.postMessage({ __apiOverlay: true, ...data }, '*');
  }

  // ── Patch fetch ───────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const id = ++requestId;
    let url, method;
    if (args[0] instanceof Request) {
      url = args[0].url;
      method = args[0].method;
    } else {
      url = String(args[0]);
      method = (args[1]?.method || 'GET').toUpperCase();
    }
    const el = getInteractedElement();
    const t0 = Date.now();

    emit({ id, url, method, kind: 'fetch', status: 'pending', element: elementInfo(el), ts: t0 });

    return _fetch.apply(this, args)
      .then(res => {
        emit({ id, url, method, kind: 'fetch', status: res.status, ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
        return res;
      })
      .catch(err => {
        emit({ id, url, method, kind: 'fetch', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
        throw err;
      });
  };

  // ── Patch XHR ─────────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ov_method = method.toUpperCase();
    this.__ov_url = url;
    return _open.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const id = ++requestId;
    const method = this.__ov_method || 'GET';
    const url = this.__ov_url || '';
    const el = getInteractedElement();
    const t0 = Date.now();
    this.__ov_id = id;

    emit({ id, url, method, kind: 'xhr', status: 'pending', element: elementInfo(el), ts: t0 });

    this.addEventListener('load', () => {
      emit({ id, url, method, kind: 'xhr', status: this.status, ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
    });
    this.addEventListener('error', () => {
      emit({ id, url, method, kind: 'xhr', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
    });

    return _send.apply(this, args);
  };
})();
