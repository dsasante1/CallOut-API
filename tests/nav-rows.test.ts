import { describe, it, expect, beforeEach } from 'vitest'
import { loadOverlay, activateOverlay, sendToOverlay, flush, req, type OverlayApi } from './harness'

// Navigation rows (document loads, form POSTs) are recorded by the background
// worker from chrome.webRequest and pushed to the page as `ov-nav`. Their ids
// sit at or above NAV_ID_BASE; the worker owns them in the preserve store.

const NAV_ID = 1e12 + 4200 * 32
let ov: OverlayApi

const nav = (over: Record<string, unknown> = {}) => ({
  id: NAV_ID, url: 'https://app.test/login', method: 'POST', kind: 'nav', status: 'pending',
  element: null, ts: 1_700_000_000_000, reqBody: 'user=a', pageUrl: 'https://app.test/login',
  note: "The browser loaded this document itself; extensions can't read a page's HTML response.",
  ...over,
})

const chromeMock = () => (globalThis as unknown as { chrome: { runtime: { sendMessage: { mock: { calls: unknown[][] } } } } }).chrome
const preserveCalls = () => chromeMock().runtime.sendMessage.mock.calls
  .map(c => c[0] as { action: string; reqs?: Array<{ id: number }> })
  .filter(m => m.action === 'ov-preserve')

beforeEach(async () => {
  ov = loadOverlay()
  await activateOverlay()
})

describe('ov-nav rows', () => {
  it('adds the row, then merges the worker\'s later update into it', () => {
    sendToOverlay({ action: 'ov-nav', value: nav() })
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 303, ms: 80 }) })

    expect(ov.requests.size).toBe(1)
    const r = ov.requests.get(NAV_ID)
    expect(r).toMatchObject({ status: 303, ms: 80, kind: 'nav', pageUrl: 'https://app.test/login' })
  })

  it('ignores a row whose id is outside the worker\'s range', () => {
    sendToOverlay({ action: 'ov-nav', value: nav({ id: 7 }) })
    expect(ov.requests.size).toBe(0)
  })

  it('buffers rows that arrive before activation', async () => {
    ov = loadOverlay()
    sendToOverlay({ action: 'ov-nav', value: nav() })
    expect(ov.requests.size).toBe(0)
    await activateOverlay()
    expect(ov.requests.get(NAV_ID)).toBeDefined()
  })

  it('never sends a worker-owned row back to the preserve store', async () => {
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    ov.handleOverlayMessage({ __apiOverlay: true, ...req({ id: 3 }) })
    await new Promise(r => setTimeout(r, 300))   // PRESERVE_DEBOUNCE_MS

    const sent = preserveCalls().flatMap(m => m.reqs ?? []).map(r => r.id)
    expect(sent).toEqual([3])
  })

  it('renders a doc tag, a navigation initiator and the note instead of a body', () => {
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    const r = ov.requests.get(NAV_ID)

    const row = ov.rowHtml(r)
    expect(row).toContain('ov-kind-tag')
    expect(row).toContain('>doc<')
    expect(row).toContain('navigation')
    expect(ov.detailPanelHtml(r)).toContain("can&#39;t read a page")
  })

  it('stays out of the site map', () => {
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    expect(ov.smPages.size).toBe(0)
  })
})

describe('hydrateFromPreserved — worker-owned rows', () => {
  it('keeps their id so later updates still land on them', async () => {
    ov = loadOverlay({ replies: { 'ov-get-preserved': { ok: true, reqs: [nav(), req({ id: 5 })] } } })
    await activateOverlay()

    expect(ov.requests.get(NAV_ID)).toBeDefined()
    expect(ov.requests.get(-1)).toBeDefined()   // page rows are still re-keyed
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    expect(ov.requests.size).toBe(2)
    expect(ov.requests.get(NAV_ID).status).toBe(200)
  })

  it('does not overwrite a newer live copy with the stored one', async () => {
    ov = loadOverlay({ replies: { 'ov-get-preserved': { ok: true, reqs: [nav({ status: 'pending' })] } } })
    sendToOverlay({ action: 'activate' })
    // The live update arrives before the store reply is applied.
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    await flush()
    expect(ov.requests.get(NAV_ID).status).toBe(200)
  })

  it('folds each restored page row into the site map once', async () => {
    ov = loadOverlay({ replies: { 'ov-get-preserved': { ok: true, reqs: [req({ id: 5, url: 'https://app.test/api/a' })] } } })
    await activateOverlay()
    const endpoints = [...ov.smPages.values()].flatMap(p => [...p.endpoints.values()])
    expect(endpoints.map(e => e.count)).toEqual([1])
  })
})

describe('beacon and sse rows', () => {
  it('buckets a sent beacon and a closed stream as success', () => {
    expect(ov.statusBucket({ status: 'sent', kind: 'beacon' })).toBe('2xx')
    expect(ov.statusBucket({ status: 'closed', kind: 'sse' })).toBe('2xx')
    expect(ov.statusBucket({ status: 'error', kind: 'beacon' })).toBe('err')
  })

  it('opens an sse row on its frames tab', () => {
    const r = { ...req({ id: 2, kind: 'sse', status: 200, method: 'GET' }), messages: [{ dir: 'recv', body: 'hi', ts: 1 }] }
    const html = ov.detailPanelHtml(r)
    expect(html).toContain('data-tab="frames"')
    expect(html).not.toContain('data-tab="response"')
    expect(ov.rowHtml(r)).toContain('1fr')
  })
})

describe('activation gap — message order', () => {
  // activated flips before the pre-activation buffer is replayed (that waits on
  // the preserve store). A completion arriving in between must not be applied
  // ahead of its own buffered 'pending', or the row is stuck pending.
  const fromPage = (data: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { __apiOverlay: true, ...data }, source: window, origin: location.origin }))

  it('keeps a page-hook completion that lands before the buffer is replayed', async () => {
    ov = loadOverlay()
    fromPage(req({ id: 2, kind: 'sse', status: 'pending', ms: undefined }))
    sendToOverlay({ action: 'activate' })
    fromPage({ id: 2, status: 200, ms: 50 })
    await flush()
    expect(ov.requests.get(2)).toMatchObject({ status: 200, ms: 50 })
  })

  it('keeps a worker update that lands before the buffer is replayed', async () => {
    ov = loadOverlay()
    sendToOverlay({ action: 'ov-nav', value: nav() })
    sendToOverlay({ action: 'activate' })
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    await flush()
    expect(ov.requests.get(NAV_ID).status).toBe(200)
  })
})

describe('page messages cannot reach worker-owned rows', () => {
  const fromPage = (data: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { __apiOverlay: true, ...data }, source: window, origin: location.origin }))

  it('ignores a page message that reuses a nav row id', async () => {
    sendToOverlay({ action: 'ov-nav', value: nav({ status: 200 }) })
    fromPage({ id: NAV_ID, status: 500, url: 'https://evil.test/' })
    fromPage({ __wsMsg: true, wsId: NAV_ID, dir: 'recv', body: 'x', ts: 1 })
    fromPage(req({ id: NAV_ID + 1 }))
    await flush()

    expect(ov.requests.get(NAV_ID)).toMatchObject({ status: 200, url: 'https://app.test/login' })
    expect(ov.requests.get(NAV_ID).messages).toBeUndefined()
    expect(ov.requests.has(NAV_ID + 1)).toBe(false)
  })
})
