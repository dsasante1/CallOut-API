import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The worker observes main-frame navigations through chrome.webRequest, writes
// each hop into the tab's preserve store and pushes it to the page as `ov-nav`.
// dist/background.js is evaluated against a chrome mock that keeps the
// listeners it registers, so tests can play a navigation's event sequence.

type Listener = (d: Record<string, unknown>) => void
type Row = Record<string, unknown> & { id: number }

const TAB = 7
const BASE = 1e12

let listeners: Record<string, Listener>
let session: Record<string, unknown>
let pushed: Row[]
let local: Record<string, unknown>
let runtimeListener: ((msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown) | null = null

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }

function loadWorker(allowed: string[] = ['app.test']): void {
  listeners = {}
  session = {}
  pushed = []
  local = { ovAllowedHosts: allowed }
  const event = (name: string) => ({ addListener: vi.fn((fn: Listener) => { listeners[name] = fn }) })
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { onMessage: { addListener: vi.fn((fn: typeof runtimeListener) => { runtimeListener = fn }) } },
    storage: {
      local: { get: vi.fn(async (k: string) => ({ [k]: local[k] })) },
      session: {
        get: vi.fn(async (k: string) => (k in session ? { [k]: session[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(session, structuredClone(o)) }),
        remove: vi.fn(async (k: string) => { delete session[k] }),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      create: vi.fn(async () => ({ id: TAB })),
      get: vi.fn(async () => ({ id: TAB, status: 'complete' })),
      remove: vi.fn(async () => {}),
      sendMessage: vi.fn(async (_tab: number, msg: { action: string; value: Row }) => {
        if (msg.action === 'ov-nav') pushed.push(msg.value)
      }),
    },
    webRequest: {
      onBeforeRequest: event('before'),
      onSendHeaders: event('headers'),
      onBeforeRedirect: event('redirect'),
      onCompleted: event('completed'),
      onErrorOccurred: event('error'),
    },
  }
  new Function(readFileSync(resolve(__dirname, '../dist/background.js'), 'utf8'))()
}

const stored = (): Row[] => (session[`ovTab_${TAB}`] as Row[] | undefined) ?? []
const fire = (name: string, d: Record<string, unknown>) => listeners[name]({ tabId: TAB, frameId: 0, type: 'main_frame', ...d })

beforeEach(() => loadWorker())

describe('background — navigation capture', () => {
  it('records a form POST, its 303 redirect and the GET that follows as separate rows', async () => {
    fire('before', {
      requestId: '42', url: 'https://app.test/login', method: 'POST', timeStamp: 1000,
      initiator: 'https://app.test', requestBody: { formData: { user: ['ada'], tags: ['a', 'b'] } },
    })
    fire('headers', { requestId: '42', url: 'https://app.test/login', requestHeaders: [{ name: 'Accept', value: 'text/html' }] })
    fire('redirect', {
      requestId: '42', url: 'https://app.test/login', statusCode: 303, timeStamp: 1080,
      redirectUrl: 'https://app.test/home', responseHeaders: [{ name: 'Location', value: '/home' }],
    })
    // The browser runs the redirected hop through onBeforeRequest again.
    fire('before', { requestId: '42', url: 'https://app.test/home', method: 'GET', timeStamp: 1081 })
    fire('completed', { requestId: '42', url: 'https://app.test/home', statusCode: 200, timeStamp: 1200, responseHeaders: [] })
    await settle()

    const rows = stored().sort((a, b) => a.id - b.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: BASE + 42 * 32, kind: 'nav', method: 'POST', url: 'https://app.test/login',
      status: 303, ms: 80, reqBody: 'user=ada&tags=a&tags=b',
      reqHeaders: [['Accept', 'text/html']], resHeaders: [['Location', '/home']],
      note: 'Redirected to https://app.test/home',
    })
    expect(rows[1]).toMatchObject({
      id: BASE + 42 * 32 + 1, method: 'GET', url: 'https://app.test/home', status: 200, ms: 120,
      reqBody: null, pageUrl: 'https://app.test/home',
    })
    // Every change is pushed to the page, final state last.
    expect(pushed.at(-1)).toMatchObject({ id: BASE + 42 * 32 + 1, status: 200 })
  })

  it('keeps the method and body across a 307', async () => {
    fire('before', { requestId: '5', url: 'https://app.test/a', method: 'POST', timeStamp: 0, requestBody: { formData: { x: ['1'] } } })
    fire('redirect', { requestId: '5', statusCode: 307, timeStamp: 1, redirectUrl: 'https://app.test/b' })
    await settle()
    expect(stored().find(r => r.url === 'https://app.test/b')).toMatchObject({ method: 'POST', reqBody: 'x=1', status: 'pending' })
  })

  it('records a failed navigation with the network error', async () => {
    fire('before', { requestId: '9', url: 'https://app.test/down', method: 'GET', timeStamp: 0 })
    fire('error', { requestId: '9', url: 'https://app.test/down', timeStamp: 30, error: 'net::ERR_CONNECTION_REFUSED' })
    await settle()
    expect(stored()[0]).toMatchObject({ status: 'error', ms: 30, note: 'net::ERR_CONNECTION_REFUSED' })
  })

  it('records a navigation away from an allowed site, by its initiator', async () => {
    fire('before', { requestId: '3', url: 'https://sso.other/auth', method: 'GET', timeStamp: 0, initiator: 'https://app.test' })
    await settle()
    expect(stored()).toHaveLength(1)
  })

  it('ignores navigations that touch no allowed host', async () => {
    fire('before', { requestId: '1', url: 'https://elsewhere.test/', method: 'GET', timeStamp: 0 })
    fire('completed', { requestId: '1', statusCode: 200, timeStamp: 5 })
    await settle()
    expect(stored()).toHaveLength(0)
    expect(pushed).toHaveLength(0)
  })

  it('ignores prerenders and requests outside a tab', async () => {
    fire('before', { requestId: '2', url: 'https://app.test/', method: 'GET', timeStamp: 0, documentLifecycle: 'prerender' })
    fire('before', { requestId: '3', url: 'https://app.test/', method: 'GET', timeStamp: 0, tabId: -1 })
    await settle()
    expect(stored()).toHaveLength(0)
  })

  it('decodes a raw (non-form) body', async () => {
    const bytes = new TextEncoder().encode('{"q":1}').buffer
    fire('before', { requestId: '8', url: 'https://app.test/x', method: 'POST', timeStamp: 0, requestBody: { raw: [{ bytes }] } })
    await settle()
    expect(stored()[0].reqBody).toBe('{"q":1}')
  })
})

describe('background — site-map scan harvest', () => {
  it('returns the calls the scanned page made, not its own document load', async () => {
    vi.useFakeTimers()
    try {
      let reply: { reqs?: Row[] } | undefined
      runtimeListener!({ action: 'sm-scan', url: 'https://app.test/page' }, { tab: { id: 1 } }, r => { reply = r as { reqs?: Row[] } })
      await vi.advanceTimersByTimeAsync(0)
      // While the scan tab loads: its document request and one API call.
      fire('before', { requestId: '77', url: 'https://app.test/page', method: 'GET', timeStamp: 0 })
      fire('completed', { requestId: '77', statusCode: 200, timeStamp: 5 })
      await vi.advanceTimersByTimeAsync(0)
      runtimeListener!({ action: 'ov-preserve', reqs: [{ id: 1, url: 'https://app.test/api/x', method: 'GET', kind: 'fetch', status: 200, ts: 1 }], wsDeltas: {} },
        { tab: { id: TAB } }, () => {})
      await vi.advanceTimersByTimeAsync(3000)   // SM_SCAN_SETTLE_MS

      expect(reply?.reqs?.map(r => r.url)).toEqual(['https://app.test/api/x'])
    } finally {
      vi.useRealTimers()
    }
  })
})
