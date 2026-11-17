import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadOverlay, req, type OverlayApi } from './harness'

// Navigation for "reveal all values on page". Opening a response highlights its
// values and the response bar says so, with ‹ › beside it — nothing to click
// first. Pressing ‹ or › (or the note itself) starts navigating, and the note
// becomes a "3 / 11 ×" pill. All of it stays in the overlay; only the highlights
// are on the page. ] / [ step once navigation has started.
//
// jsdom does no layout, so geometry is stubbed per element from data-left /
// data-top / data-width / data-height (viewport is 1024×768); `data-hidden` makes
// it unlaid-out. Page elements default to 100×20 far below the fold; the panel
// defaults to x 600–1000 over the full height, and follows its translate().

let ov: OverlayApi
let scrolled: string[]

const BODY = JSON.stringify({ items: ['alpha-value', 'bravo-value', 'charlie-value'] })
const settle = () => new Promise<void>(r => queueMicrotask(r))
const send = (over: Record<string, unknown>) => ov.handleOverlayMessage({ __apiOverlay: true, ...over })
const current = () => document.querySelector('.ov-value-current')?.id
const bar = () => document.querySelector<HTMLElement>('#ov-panel .ov-reveal-group')!
const info = () => bar().querySelector<HTMLElement>('.ov-reveal-info')
const pill = () => bar().querySelector<HTMLElement>('.ov-reveal-pill')
const pos = () => pill()?.querySelector('.ov-rn-pos')?.textContent
const arrows = () => bar().querySelectorAll('.ov-rn-btn')
const step = (dir: 1 | -1) => bar().querySelector<HTMLElement>(`.ov-rn-btn[data-step="${dir}"]`)!.click()
const key = (k: string, target: Element = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

function box(top: number, left = 0, width = 100, height = 20) {
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }
}

function stubLayout() {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.hasAttribute('data-hidden') ? [] : [box(0)]) as unknown as DOMRectList
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement
    const d = el.dataset ?? {}
    const isPanel = el.id === 'ov-panel'
    const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style?.transform ?? '')
    const dx = isPanel && t ? Number(t[1]) : 0
    const dy = isPanel && t ? Number(t[2]) : 0
    return box(
      Number(d.top ?? (isPanel ? 0 : 2000)) + dy,
      Number(d.left ?? (isPanel ? 600 : 0)) + dx,
      Number(d.width ?? (isPanel ? 400 : 100)),
      Number(d.height ?? (isPanel ? 768 : 20)),
    ) as DOMRect
  })
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this.id) })
}

// The response renders `html` into the page, then the user opens it in the dock:
// runBulkHighlight is what opening the Response tab runs, followed by a render.
async function openResponse(html: string, intoPage = () => {
  document.getElementById('app')!.insertAdjacentHTML('beforeend', html)
}, over: Record<string, unknown> = {}): Promise<void> {
  send(req({ id: 1, kind: 'xhr', ts: Date.now() - 110, ms: 100, resBody: BODY, ...over }))
  send({ id: 1, readTs: Date.now() })            // the page reads the body, then renders
  intoPage()
  await settle()
  vi.advanceTimersByTime(500)
  ov.runBulkHighlight(1)
  ov.syncRevealBar()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  ov = loadOverlay()
  scrolled = []
  stubLayout()
  document.body.innerHTML = '<main id="app"><section id="top"></section><section id="bottom"></section></main>'
  // The dock's response bar as responseBodyHtml renders it, inside the overlay
  // so it never matches as page content; clicks go through the real delegate.
  document.documentElement.insertAdjacentHTML('beforeend',
    '<div id="ov-panel"><div id="ov-dock"><div class="ov-body-bar">'
    + '<span class="ov-reveal-group" data-id="1"></span></div></div></div>')
  ov.bindListDelegation(document.getElementById('ov-dock'))
  ov.startMutationLog()
  vi.advanceTimersByTime(1500)   // page settled after load, so reads get a footprint
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reveal all — before navigating', () => {
  it('says the response has matches and shows ‹ › straight away, without scrolling', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p>')

    expect(info()?.textContent).toBe('⊹ 2 matches on this page — use ‹ › to go to them')
    expect(arrows()).toHaveLength(2)
    expect(pill()).toBeNull()
    expect(scrolled).toEqual([])
    expect(current()).toBeUndefined()
    expect(document.getElementById('ov-value-cycler')).toBeNull()   // nothing floats on the page
  })

  it('says so when no values are on the page', async () => {
    await openResponse('<p id="x">unrelated text</p>')

    expect(bar().textContent).toBe('⊹ no values from this response on this page')
    expect(arrows()).toHaveLength(0)
  })

  it('offers no arrows when every match is hidden', async () => {
    await openResponse('<p id="a" data-hidden>alpha-value</p>')

    expect(bar().textContent).toBe('⊹ 1 match on this page, none visible')
    expect(arrows()).toHaveLength(0)
  })
})

describe('reveal all — navigating', () => {
  it('› turns the note into a pill and goes to the first match in page order', async () => {
    await openResponse('', () => {
      // Rendered bottom-first, so footprint order differs from page order.
      document.getElementById('bottom')!.innerHTML = '<p id="b">bravo-value</p>'
      document.getElementById('top')!.innerHTML = '<p id="a">alpha-value</p>'
    })

    step(1)
    expect(info()).toBeNull()
    expect(pos()).toBe('1 / 2')
    expect(pill()!.querySelector('.ov-rn-end')).not.toBeNull()
    expect(arrows()).toHaveLength(2)
    expect(scrolled).toEqual(['a'])
    expect(current()).toBe('a')
  })

  it('‹ as the first press starts from the last match', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="b">bravo-value</p><p id="c">charlie-value</p>')

    step(-1)
    expect(current()).toBe('c')
    expect(pos()).toBe('3 / 3')
  })

  it('clicking the note itself starts navigating like ›', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p>')

    info()!.click()
    expect(current()).toBe('a')
    expect(pos()).toBe('1 / 2')
  })

  it('steps and wraps, skipping matches that are not laid out', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="b" data-hidden>bravo-value</p><p id="c">charlie-value</p>')

    step(1)
    expect(pos()).toBe('1 / 2')
    step(1)
    expect(current()).toBe('c')
    expect(pos()).toBe('2 / 2')
    step(1)
    expect(current()).toBe('a')
    step(-1)
    expect(current()).toBe('c')
    // The hidden match is still highlighted, just not a stop.
    expect(document.getElementById('b')!.classList.contains('ov-value-match')).toBe(true)
  })

  it('× ends navigation: the pill turns back into the note and the highlights stay', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p>')
    step(1)

    bar().querySelector<HTMLElement>('.ov-rn-end')!.click()
    expect(pill()).toBeNull()
    expect(info()).not.toBeNull()
    expect(current()).toBeUndefined()
    expect(document.querySelectorAll('.ov-value-match')).toHaveLength(2)
  })

  it('] and [ step only once navigation has started, and not while typing', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p><input id="field">')

    key(']')
    expect(current()).toBeUndefined()            // the page keeps its keys until ‹ › are used

    step(1)
    key(']')
    expect(current()).toBe('c')
    key('[')
    expect(current()).toBe('a')
    key(']', document.getElementById('field')!)
    expect(current()).toBe('a')
  })

  it('skips a match the page removed since highlighting', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="b">bravo-value</p><p id="c">charlie-value</p>')
    step(1)
    document.getElementById('b')!.remove()

    step(1)
    expect(current()).toBe('c')
    expect(pos()).toBe('2 / 2')
  })

  it('marks counts as capped when the match limit was hit', async () => {
    await openResponse(Array.from({ length: 60 }, (_, i) => `<p id="r${i}">alpha-value</p>`).join(''))

    expect(info()?.textContent).toBe('⊹ 50+ matches on this page — use ‹ › to go to them')
    step(1)
    expect(pos()).toBe('1 / 50+')
  })

  it('keeps the pill and position when the dock re-renders the response bar', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p>')
    step(1)
    step(1)

    const html = ov.detailPanelHtml(ov.requests.get(1))
    expect(html).toContain('<span class="ov-reveal-pill"><span class="ov-rn-pos">2 / 2</span>')
  })
})

describe('reveal all — trigger tiebreak', () => {
  it('steps through matches near the clicked element first, then the rest in page order', async () => {
    document.getElementById('app')!.insertAdjacentHTML('beforeend',
      '<section id="results"><button id="load-more">Load more</button><ul id="list"></ul></section>')
    await settle()
    vi.advanceTimersByTime(1000)
    await openResponse('', () => {
      document.getElementById('top')!.innerHTML = '<p id="a">alpha-value</p>'
      document.getElementById('list')!.innerHTML = '<li id="b">bravo-value</li><li id="c">charlie-value</li>'
    }, { element: { selector: '#load-more', label: 'Load more' } })

    step(1)
    expect(current()).toBe('b')
    step(1)
    expect(current()).toBe('c')
    step(1)
    expect(current()).toBe('a')
  })

  it('keeps page order when the request had no trigger', async () => {
    await openResponse('', () => {
      document.getElementById('bottom')!.innerHTML = '<p id="b">bravo-value</p>'
      document.getElementById('top')!.innerHTML = '<p id="a">alpha-value</p>'
    })

    step(1)
    expect(current()).toBe('a')
  })
})

describe('reveal all — render area outline', () => {
  const outlined = () => [...document.querySelectorAll('.ov-render-area')].map(e => e.id)

  it('outlines the render area while navigating, and removes it when navigation ends', async () => {
    await openResponse('<div id="area"><p id="a">alpha-value</p><p id="c">charlie-value</p></div>')
    expect(outlined()).toEqual([])                 // highlighting alone doesn't outline

    step(1)
    expect(outlined()).toEqual(['area'])

    bar().querySelector<HTMLElement>('.ov-rn-end')!.click()
    expect(outlined()).toEqual([])
  })

  it('outlines nothing when the search was page-wide', async () => {
    send(req({ id: 1, kind: 'xhr', ts: Date.now() - 110, ms: 100, resBody: BODY }))   // never read by the page
    document.getElementById('app')!.insertAdjacentHTML('beforeend', '<p id="a">alpha-value</p>')
    await settle()
    vi.advanceTimersByTime(2500)
    ov.runBulkHighlight(1)
    ov.syncRevealBar()

    step(1)
    expect(current()).toBe('a')
    expect(outlined()).toEqual([])
  })
})

describe('reveal all — after a single-value trace', () => {
  it('offers "reveal all" again, which highlights and shows the note without scrolling', async () => {
    await openResponse('<p id="a">alpha-value</p><p id="c">charlie-value</p>')
    // A JSON value span as the dock renders it.
    document.getElementById('ov-dock')!.insertAdjacentHTML('beforeend',
      '<div class="ov-body-json" data-id="1"><span id="jv" class="ov-jv" data-ov-val="alpha-value" data-ov-kind="string"></span></div>')
    ov.handleJsonValueClick(document.getElementById('jv'))
    expect(bar().querySelector('.ov-reveal-all')).not.toBeNull()

    scrolled = []
    bar().querySelector<HTMLElement>('.ov-reveal-all')!.click()
    expect(info()?.textContent).toBe('⊹ 2 matches on this page — use ‹ › to go to them')
    expect(document.querySelectorAll('.ov-value-match')).toHaveLength(2)
    expect(scrolled).toEqual([])
  })
})

describe('reveal all — floating panel', () => {
  const panel = () => document.getElementById('ov-panel')!
  const shift = () => panel().style.transform

  it('steps aside to the nearest clear edge for a hidden match, then slides home', async () => {
    // `a` is below the fold at x 650, so it will land (centred) under the panel;
    // `c` is in view at x 0, clear of the panel's home position.
    await openResponse('<p id="a" data-left="650">alpha-value</p><p id="c" data-top="400">charlie-value</p>')
    const setStorage = vi.mocked(chrome.storage.local.set)
    setStorage.mockClear()

    step(1)
    expect(current()).toBe('a')
    expect(shift()).toBe('translate(-584px, 0px)')   // left edge: 600 → 16, the only side that clears x 650
    expect(panel().classList.contains('ov-trace-fade')).toBe(false)

    step(1)
    expect(current()).toBe('c')
    expect(shift()).toBe('')
    // The saved panel position is never rewritten by a dodge.
    expect(setStorage.mock.calls.some(([v]) => 'ovPanelGeom' in (v as object))).toBe(false)
  })

  it('stays put for a match less than half hidden', async () => {
    await openResponse('<p id="a" data-top="300" data-left="540">alpha-value</p>')   // 40 of 100px under the panel

    step(1)
    expect(shift()).toBe('')
    expect(panel().classList.contains('ov-trace-fade')).toBe(false)
  })

  it('fades instead when no edge would clear the match', async () => {
    panel().dataset.left = '100'
    panel().dataset.width = '900'                       // too wide to get out of the way
    await openResponse('<p id="a" data-top="300" data-left="400">alpha-value</p>')

    step(1)
    expect(shift()).toBe('')
    expect(panel().classList.contains('ov-trace-fade')).toBe(true)
  })

  it('× sends the panel home', async () => {
    await openResponse('<p id="a" data-top="300" data-left="650">alpha-value</p>')
    step(1)
    expect(shift()).not.toBe('')

    bar().querySelector<HTMLElement>('.ov-rn-end')!.click()
    expect(shift()).toBe('')
  })

  it('grabbing the panel while it is aside makes that its real position', async () => {
    await openResponse('<p id="a" data-top="300" data-left="650">alpha-value</p>')
    step(1)

    ov.commitPanelDodge(panel())
    expect(shift()).toBe('')
    expect(panel().style.left).toBe('16px')
    expect(panel().style.top).toBe('0px')
  })
})
