import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadOverlay, req, type OverlayApi } from './harness'

// The render footprint scopes "reveal all values" (and single-value tracing) to
// the part of the page a response rendered into: what changed once the page read
// the response (the hook's `{ id, readTs }`). These tests drive real DOM
// mutations through the MutationObserver; only Date and setTimeout are faked, so
// jsdom still delivers observer callbacks on its microtask queue.
//
// Window timings from content.ts: FOOTPRINT_SLACK_MS = 50, FOOTPRINT_QUIET_MS =
// 300, FOOTPRINT_MAX_MS = 2000, MUTATION_LOG_MS = 3000. The page counts as loaded
// when the overlay loads, and settles after PAGE_SETTLE_QUIET_MS = 1000 of quiet
// (PAGE_SETTLE_MAX_MS = 5000 at the latest); most tests start once it has.

let ov: OverlayApi

const BODY = JSON.stringify({ user: { name: 'alice_smith', city: 'Lisbon-Norte' } })

const settle = () => new Promise<void>(r => queueMicrotask(r))
const send = (over: Record<string, unknown>) => ov.handleOverlayMessage({ __apiOverlay: true, ...over })
const ids = (els: Element[]) => els.map(e => e.id)

// A request that finished and was read by the page `agoMs` before now, with the
// body in the same message (the XHR shape).
function landXhr(agoMs = 10, over: Record<string, unknown> = {}) {
  send(req({ id: 1, kind: 'xhr', ts: Date.now() - agoMs - 100, ms: 100, resBody: BODY, ...over }))
  pageReads(agoMs)
}

// The hook's report that the page read request 1's body `agoMs` ago.
function pageReads(agoMs = 0) {
  send({ id: 1, readTs: Date.now() - agoMs })
}

function render(html: string) {
  document.getElementById('app')!.insertAdjacentHTML('beforeend', html)
}

const highlighted = () => ids([...document.querySelectorAll('.ov-value-match')])

function loadPage() {
  ov = loadOverlay()
  // Pre-existing page: the same name already shows in the header, not from this response.
  document.body.innerHTML = '<header id="hdr">alice_smith</header><main id="app"></main>'
  ov.startMutationLog()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  loadPage()
  vi.advanceTimersByTime(1500)   // page settled
})

afterEach(() => { vi.useRealTimers() })

describe('render footprint — recording', () => {
  it('scopes reveal-all to what the response rendered; the same value elsewhere is not highlighted', async () => {
    landXhr()
    render('<ul id="list"><li id="row">alice_smith</li><li id="city">Lisbon-Norte</li></ul>')
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['row', 'city'])
    expect(ov.revealBarHtml(1)).toContain('⊹ 2 matches on this page')
  })

  it('catches a render that happened before the read report reached the content script', async () => {
    render('<p id="early">alice_smith</p>')   // page handler ran first
    await settle()
    vi.advanceTimersByTime(5)
    landXhr(20)                                // page read the body 20ms ago, before the render
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['early'])
  })

  it('excludes DOM changes made well before the page read the response', async () => {
    render('<p id="stale">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(1000)
    landXhr(10)
    render('<p id="fresh">Lisbon-Norte</p>')
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['fresh'])
  })

  it('starts at the page\'s read, not network completion: what renders in between is not this response\'s', async () => {
    send(req({ id: 1, kind: 'fetch', ts: Date.now() - 110, ms: 100 }))   // network done
    send({ id: 1, resBody: BODY })
    vi.advanceTimersByTime(100)
    render('<p id="other">alice_smith</p>')                              // something else renders meanwhile
    await settle()
    vi.advanceTimersByTime(700)                                          // page reads the body later
    pageReads()
    render('<p id="ours">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['ours'])
  })

  it('gives a request the page never reads no footprint, so the search is page-wide and loose', async () => {
    send(req({ id: 1, kind: 'xhr', ts: Date.now() - 110, ms: 100, resBody: BODY }))   // e.g. telemetry
    render('<p id="row">alice_smith</p><a id="slug">alice_smith/forward</a>')
    await settle()
    vi.advanceTimersByTime(2500)

    expect(ov.renderFootprints.has(1)).toBe(false)
    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['hdr', 'row', 'slug'])
  })

  it('ignores a read report for a request it no longer holds', () => {
    send({ id: 99, readTs: Date.now() })
    expect(ov.requests.has(99)).toBe(false)
  })

  it('ignores changes inside the overlay\'s own UI', async () => {
    landXhr()
    document.body.insertAdjacentHTML('beforeend', '<div id="ov-panel"><span>alice_smith</span></div>')
    await settle()
    vi.advanceTimersByTime(500)

    expect(ov.renderFootprints.has(1)).toBe(false)
  })

  it('collapses a render spread over many separate insertions to their common parent', async () => {
    render('<ul id="feed"></ul>')
    await settle()
    vi.advanceTimersByTime(1000)
    landXhr()
    const feed = document.getElementById('feed')!
    for (let i = 0; i < 250; i++) {
      const li = document.createElement('li')
      li.textContent = `row ${i}`
      feed.appendChild(li)
      await settle()   // one observer batch per row, as an incremental render would
    }
    vi.advanceTimersByTime(500)

    expect(ov.renderFootprints.get(1)).toEqual([feed])
  })
})

describe('render footprint — strict matching', () => {
  it('matches a value only as an element\'s whole text, so a username doesn\'t light up links containing it', async () => {
    landXhr()
    render('<li id="exact">Alice_Smith</li><a id="slug">alice_smith/forward</a><li id="label">Name: alice_smith</li>')
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['exact'])
  })

  it('still matches long values inside longer text', async () => {
    landXhr()
    render('<p id="addr">Lives in Lisbon-Norte, Portugal</p>')   // "Lisbon-Norte" is 12 characters
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['addr'])
  })

  it('applies to a single traced value too', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    landXhr()
    render('<p id="exact">alice_smith</p><a id="slug">alice_smith/forward</a>')
    await settle()
    vi.advanceTimersByTime(500)
    document.documentElement.insertAdjacentHTML('beforeend',
      '<div id="ov-panel"><div class="ov-body-json" data-id="1"><span id="jv" class="ov-jv" data-ov-val="alice_smith" data-ov-kind="string"></span></div></div>')

    ov.handleJsonValueClick(document.getElementById('jv'))
    expect(highlighted()).toEqual(['exact'])
  })
})

describe('render footprint — page load', () => {
  beforeEach(() => { loadPage() })   // fresh load, not yet settled

  it('gives a response read while the page is loading no footprint, and matches it strictly page-wide', async () => {
    render('<a id="repo">alice_smith/forward</a><p id="mine">alice_smith</p>')   // the page rendering itself
    await settle()
    vi.advanceTimersByTime(200)
    landXhr(0)                                                                    // read mid-load
    await settle()
    vi.advanceTimersByTime(2500)

    expect(ov.renderFootprints.has(1)).toBe(false)
    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['hdr', 'mine'])   // exact values only; the repo link is left alone
  })

  it('scopes again once the page has been quiet for a second', async () => {
    render('<p id="boot">booting</p>')
    await settle()
    vi.advanceTimersByTime(1200)                      // quiet spell: settled
    landXhr(0)
    render('<p id="row">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(500)

    expect(ov.renderFootprints.has(1)).toBe(true)
  })

  it('treats a page that never goes quiet as settled five seconds after load', async () => {
    for (let i = 0; i < 26; i++) {                    // a ticking clock: a change every 200ms
      render(`<i>${i}</i>`)
      await settle()
      vi.advanceTimersByTime(200)
    }
    landXhr(0)
    render('<p id="row">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(500)

    expect(ov.renderFootprints.has(1)).toBe(true)
  })
})

describe('render footprint — label', () => {
  it('reports no matches in the rendered area even when the value is elsewhere on the page', async () => {
    landXhr()
    render('<p id="other">unrelated text</p>')
    await settle()
    vi.advanceTimersByTime(500)

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual([])
    expect(ov.revealBarHtml(1)).toContain('⊹ no values from this response on this page')
  })
})

describe('render footprint — fallback', () => {
  it('searches page-wide when the request has no footprint', () => {
    render('<p id="row">alice_smith</p>')   // rendered while nothing was tracking request 1
    ov.requests.set(1, { ...req({ id: 1 }), resBody: BODY })

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['hdr', 'row'])
    expect(ov.revealBarHtml(1)).toContain('⊹ 2 matches on this page')
  })

  it('falls back to page-wide once every footprint element has been replaced', async () => {
    landXhr()
    render('<p id="row">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(500)
    document.getElementById('app')!.innerHTML = '<p id="rerendered">alice_smith</p>'

    ov.runBulkHighlight(1)
    expect(highlighted()).toEqual(['hdr', 'rerendered'])
  })
})

describe('render footprint — single value trace', () => {
  it('traces a single value only within the footprint', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    landXhr()
    render('<p id="row">alice_smith</p>')
    await settle()
    vi.advanceTimersByTime(500)
    // A JSON value span as the dock renders it; inside #ov-panel so it isn't itself a match.
    document.documentElement.insertAdjacentHTML('beforeend',
      '<div id="ov-panel"><div class="ov-body-json" data-id="1"><span id="jv" class="ov-jv" data-ov-val="alice_smith" data-ov-kind="string"></span></div></div>')

    ov.handleJsonValueClick(document.getElementById('jv'))
    expect(document.querySelector('.ov-value-current')?.id).toBe('row')
    expect(highlighted()).toEqual(['row'])
  })
})
