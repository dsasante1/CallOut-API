interface Window {
  __apiOverlayActive?: boolean;
}

interface XMLHttpRequest {
  __ov_method?: string;
  __ov_url?: string;
  __ov_id?: number;
}

(function () {
  if (window.__apiOverlayActive) return;
  window.__apiOverlayActive = true;

  let requestId = 0;
  let lastInteractedEl: Element | null = null;
  let lastInteractTime = 0;

  interface ElementInfo {
    selector: string;
    label: string;
  }

  ['mousedown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, (e: Event) => {
      lastInteractedEl = e.target as Element;
      lastInteractTime = Date.now();
    }, { capture: true, passive: true });
  });

  function getInteractedElement(): Element | null {
    return (Date.now() - lastInteractTime < 800) ? lastInteractedEl : null;
  }

  function uniqueSelector(el: Element): string {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      const parent: HTMLElement | null = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function elementInfo(el: Element | null): ElementInfo | null {
    if (!el) return null;
    const htmlEl = el as HTMLElement;
    return {
      selector: uniqueSelector(el),
      label: (htmlEl.innerText || (htmlEl as HTMLInputElement).value || el.getAttribute('aria-label') || el.tagName)
               .toString().trim().slice(0, 60)
    };
  }

  function emit(data: Record<string, unknown>): void {
    window.postMessage({ __apiOverlay: true, ...data }, '*');
  }

  function extractBody(body: BodyInit | null | undefined): string | null {
    if (body == null) return null;
    if (typeof body === 'string') return body.slice(0, 50000);
    if (body instanceof URLSearchParams) return body.toString().slice(0, 50000);
    if (body instanceof FormData) return '[FormData]';
    return '[Binary]';
  }

  const _fetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const id = ++requestId;
    let url: string;
    let method: string;
    let reqBody: string | null = null;
    if (args[0] instanceof Request) {
      url = args[0].url;
      method = args[0].method.toUpperCase();
    } else {
      url = String(args[0]);
      const init = args[1] as RequestInit | undefined;
      method = (init?.method || 'GET').toUpperCase();
      reqBody = extractBody(init?.body);
    }
    const el = getInteractedElement();
    const t0 = Date.now();

    emit({ id, url, method, kind: 'fetch', status: 'pending', element: elementInfo(el), ts: t0, reqBody });

    return _fetch.apply(this, args)
      .then(res => {
        const ms = Date.now() - t0;
        emit({ id, url, method, kind: 'fetch', status: res.status, ms, element: elementInfo(el), ts: t0, reqBody });
        res.clone().text().then(text => {
          emit({ id, resBody: text.slice(0, 50000) });
        }).catch(() => {});
        return res;
      })
      .catch(err => {
        emit({ id, url, method, kind: 'fetch', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody });
        throw err;
      });
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  // Cast to any to bypass overload signature mismatch — we forward all args as-is
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (XMLHttpRequest.prototype as any).open = function (method: string, url: string | URL, ...rest: unknown[]): void {
    this.__ov_method = method.toUpperCase();
    this.__ov_url = String(url);
    (_open as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args: Parameters<typeof XMLHttpRequest.prototype.send>): void {
    const id = ++requestId;
    const method = this.__ov_method || 'GET';
    const url = this.__ov_url || '';
    const reqBody = extractBody(args[0] as BodyInit | null);
    const el = getInteractedElement();
    const t0 = Date.now();
    this.__ov_id = id;

    emit({ id, url, method, kind: 'xhr', status: 'pending', element: elementInfo(el), ts: t0, reqBody });

    this.addEventListener('load', () => {
      const resBody = (this.responseType === '' || this.responseType === 'text')
        ? this.responseText?.slice(0, 50000)
        : null;
      emit({ id, url, method, kind: 'xhr', status: this.status, ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody, resBody });
    });
    this.addEventListener('error', () => {
      emit({ id, url, method, kind: 'xhr', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0, reqBody });
    });

    _send.apply(this, args);
  };

  const _WebSocket = window.WebSocket;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).WebSocket = function (url: string | URL, protocols?: string | string[]) {
    const ws = new _WebSocket(url, protocols);
    const id = ++requestId;
    const el = getInteractedElement();
    const t0 = Date.now();
    const wsUrl = String(url);

    emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 'pending', element: elementInfo(el), ts: t0 });

    ws.addEventListener('open', () => {
      emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 101, ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
    });

    ws.addEventListener('close', (e: CloseEvent) => {
      emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: e.wasClean ? 'closed' : 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
    });

    ws.addEventListener('error', () => {
      emit({ id, url: wsUrl, method: 'WS', kind: 'ws', status: 'error', ms: Date.now() - t0, element: elementInfo(el), ts: t0 });
    });

    ws.addEventListener('message', (e: MessageEvent) => {
      const body = typeof e.data === 'string' ? (e.data as string).slice(0, 10000) : '[Binary]';
      emit({ __wsMsg: true, wsId: id, dir: 'recv', body, ts: Date.now() });
    });

    const _origSend = ws.send.bind(ws);
    ws.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      const body = typeof data === 'string' ? (data as string).slice(0, 10000) : '[Binary]';
      emit({ __wsMsg: true, wsId: id, dir: 'sent', body, ts: Date.now() });
      return _origSend(data);
    };

    return ws;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _win = window as any;
  _win.WebSocket.prototype = _WebSocket.prototype;
  _win.WebSocket.CONNECTING = _WebSocket.CONNECTING;
  _win.WebSocket.OPEN = _WebSocket.OPEN;
  _win.WebSocket.CLOSING = _WebSocket.CLOSING;
  _win.WebSocket.CLOSED = _WebSocket.CLOSED;
})();
