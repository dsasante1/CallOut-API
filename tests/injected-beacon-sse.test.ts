import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The page hook also wraps navigator.sendBeacon and EventSource. jsdom has
// neither, so stand-ins are installed before the hook is evaluated — it wraps
// whatever is there at install time, exactly as it would in the browser.

type Msg = Record<string, unknown>
let posted: Msg[] = []
let beaconResult = true
const beaconCalls: unknown[][] = []

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly url: string
  readyState = FakeEventSource.CONNECTING
  constructor(url: string | URL) {
    super()
    this.url = new URL(String(url), 'https://app.test/').href
  }
  close(): void { this.readyState = FakeEventSource.CLOSED }
  // Test drivers — what the browser does on the wire.
  serverOpen(): void { this.readyState = FakeEventSource.OPEN; this.dispatchEvent(new Event('open')) }
  serverSend(data: string, type = 'message'): void { this.dispatchEvent(new MessageEvent(type, { data })) }
  serverFail(final: boolean): void {
    this.readyState = final ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING
    this.dispatchEvent(new Event('error'))
  }
}

beforeAll(() => {
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true, writable: true,
    value: (...args: unknown[]) => { beaconCalls.push(args); return beaconResult },
  })
  ;(window as unknown as { EventSource: unknown }).EventSource = FakeEventSource
  vi.spyOn(window, 'postMessage').mockImplementation(((msg: Msg) => { posted.push(msg) }) as typeof window.postMessage)
  new Function(readFileSync(resolve(__dirname, '../dist/injected.js'), 'utf8'))()
})

beforeEach(() => { posted = []; beaconResult = true; beaconCalls.length = 0 })

const rows = () => posted.filter(m => !m.__wsMsg)
const frames = () => posted.filter(m => m.__wsMsg)

describe('injected — sendBeacon', () => {
  it('still sends the beacon and records it as sent', () => {
    expect(navigator.sendBeacon('/collect', 'a=1')).toBe(true)

    expect(beaconCalls).toEqual([['/collect', 'a=1']])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ url: '/collect', method: 'POST', kind: 'beacon', status: 'sent', reqBody: 'a=1' })
  })

  it('records a beacon the browser refused as an error and passes the result through', () => {
    beaconResult = false
    expect(navigator.sendBeacon('/collect', 'x')).toBe(false)
    expect(rows()[0].status).toBe('error')
  })

  it('reads a JSON Blob body asynchronously', async () => {
    navigator.sendBeacon('/collect', new Blob(['{"ev":"view"}'], { type: 'application/json' }))
    await settle()

    const [row, patch] = posted
    expect(row.reqBody).toBe('[Binary]')
    expect(patch).toEqual({ __apiOverlay: true, id: row.id, reqBody: '{"ev":"view"}' })
  })
})

describe('injected — EventSource', () => {
  const open = (url = '/stream') => new EventSource(url) as unknown as FakeEventSource

  it('records the connection, opens at 200 and keeps its EventSource identity', () => {
    const es = open()
    expect(es).toBeInstanceOf(FakeEventSource)
    es.serverOpen()

    expect(rows().map(r => r.status)).toEqual(['pending', 200])
    expect(rows()[0]).toMatchObject({ url: 'https://app.test/stream', method: 'GET', kind: 'sse' })
  })

  it('records unnamed messages and the named events the page subscribes to', () => {
    const es = open()
    const pageSaw: string[] = []
    es.addEventListener('update', e => { pageSaw.push((e as MessageEvent).data) })
    es.serverOpen()
    es.serverSend('hello')
    es.serverSend('v2', 'update')

    expect(pageSaw).toEqual(['v2'])   // the page's own listener still runs
    expect(frames().map(f => f.body)).toEqual(['hello', '[update] v2'])
    expect(frames().every(f => f.dir === 'recv' && f.wsId === rows()[0].id)).toBe(true)
  })

  it('records each named event once however many listeners the page adds', () => {
    const es = open()
    es.addEventListener('tick', () => {})
    es.addEventListener('tick', () => {})
    es.serverSend('1', 'tick')
    expect(frames()).toHaveLength(1)
  })

  it('shows a retry as pending and a final failure as an error', () => {
    const es = open()
    es.serverOpen()
    es.serverFail(false)
    es.serverFail(true)
    expect(rows().map(r => r.status)).toEqual(['pending', 200, 'pending', 'error'])
  })

  it('records the page closing the stream, once', () => {
    const es = open()
    es.serverOpen()
    es.close()
    es.close()
    expect(rows().map(r => r.status)).toEqual(['pending', 200, 'closed'])
  })
})
