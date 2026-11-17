import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The page hook (dist/injected.js) reports `{ id, readTs }` the first time the
// page itself reads a response's data. That moment starts the request's render
// footprint in content.ts, so the hook must report the page's reads — and only
// those, never its own body capture.
//
// The hook patches globals (fetch, Response.prototype, XMLHttpRequest.prototype)
// and guards against double install, so it is loaded once for this file.

type Msg = Record<string, unknown>
let posted: Msg[] = []

const reads = () => posted.filter(m => 'readTs' in m)
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

beforeAll(() => {
  window.fetch = vi.fn(async () => jsonResponse({ name: 'alice_smith' })) as typeof fetch
  vi.spyOn(window, 'postMessage').mockImplementation(((msg: Msg) => { posted.push(msg) }) as typeof window.postMessage)
  const src = readFileSync(resolve(__dirname, '../dist/injected.js'), 'utf8')
  new Function(src)()
})

beforeEach(() => { posted = [] })

describe('injected — fetch body reads', () => {
  it('reports the page reading the body, before the page\'s own continuation runs', async () => {
    const order: string[] = []
    const res = await fetch('/api/user')
    const data = await res.json().then(v => { order.push(`page saw read report: ${reads().length}`); return v })
    await settle()

    expect(data).toEqual({ name: 'alice_smith' })
    expect(order).toEqual(['page saw read report: 1'])
    const [read] = reads()
    const pending = posted.find(m => m.status === 'pending')
    expect(read.id).toBe(pending!.id)
    expect(typeof read.readTs).toBe('number')
  })

  it('reports once per response', async () => {
    const res = await fetch('/api/user')
    void res.body
    await res.text()
    await settle()

    expect(reads()).toHaveLength(1)
  })

  it('does not count the hook\'s own body capture as a read', async () => {
    await fetch('/api/user')                     // page never touches the body
    await settle()

    expect(posted.some(m => 'resBody' in m)).toBe(true)   // the hook did capture it
    expect(reads()).toHaveLength(0)
  })

  it('ignores responses the hook didn\'t capture', async () => {
    await jsonResponse({ a: 1 }).json()
    await settle()

    expect(reads()).toHaveLength(0)
  })
})

describe('injected — XHR body reads', () => {
  function load(onload: (xhr: XMLHttpRequest) => void): Promise<void> {
    return new Promise(done => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', 'data:application/json,{"name":"alice_smith"}')
      xhr.addEventListener('load', () => { onload(xhr); done() })
      xhr.send()
    })
  }

  it('reports the page reading responseText once the request is done', async () => {
    let text = ''
    await load(xhr => { text = xhr.responseText; void xhr.response })
    await settle()

    expect(text).toBe('{"name":"alice_smith"}')
    expect(reads()).toHaveLength(1)
    expect(reads()[0].id).toBe(posted.find(m => m.status === 'pending')!.id)
  })

  it('does not count the hook\'s own capture of responseText as a read', async () => {
    await load(() => {})
    await settle()

    const done = posted.find(m => m.kind === 'xhr' && typeof m.status === 'number')
    expect(done?.resBody).toBe('{"name":"alice_smith"}')
    expect(reads()).toHaveLength(0)
  })
})
