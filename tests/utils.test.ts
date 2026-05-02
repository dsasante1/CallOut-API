import { describe, expect, it } from 'vitest'
import { escHtml, extractBody, formatBody, getHostname, getTabHostname, safeReadResponseText } from '../src/utils'

describe('escHtml', () => {
  it('escapes ampersands', () => {
    expect(escHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes angle brackets', () => {
    expect(escHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('coerces non-strings to string', () => {
    expect(escHtml(42)).toBe('42')
    expect(escHtml(null)).toBe('null')
  })

  it('neutralises a typical XSS payload', () => {
    const raw = '<img src=x onerror="alert(1)">'
    expect(escHtml(raw)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('leaves safe text unchanged', () => {
    expect(escHtml('Hello, world!')).toBe('Hello, world!')
  })
})

describe('formatBody', () => {
  it('returns empty string for null', () => {
    expect(formatBody(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(formatBody(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(formatBody('')).toBe('')
  })

  it('pretty-prints a valid JSON object', () => {
    expect(formatBody('{"a":1,"b":2}')).toBe(JSON.stringify({ a: 1, b: 2 }, null, 2))
  })

  it('pretty-prints a valid JSON array', () => {
    expect(formatBody('[1,2,3]')).toBe(JSON.stringify([1, 2, 3], null, 2))
  })

  it('handles leading whitespace before JSON', () => {
    expect(formatBody('  {"x":true}')).toBe(JSON.stringify({ x: true }, null, 2))
  })

  it('returns the original text for invalid JSON', () => {
    const broken = '{invalid json'
    expect(formatBody(broken)).toBe(broken)
  })

  it('returns plain text for non-JSON strings', () => {
    expect(formatBody('hello world')).toBe('hello world')
  })
})

describe('getHostname', () => {
  it('extracts the hostname from a full URL', () => {
    expect(getHostname('https://api.example.com/v1/users')).toBe('api.example.com')
  })

  it('handles a URL with no path', () => {
    expect(getHostname('https://example.com')).toBe('example.com')
  })

  it('handles a subdomain URL', () => {
    expect(getHostname('https://sub.domain.co.uk/path?q=1')).toBe('sub.domain.co.uk')
  })

  it('returns "unknown" for an invalid URL', () => {
    expect(getHostname('not-a-url')).toBe('unknown')
  })

  it('returns "unknown" for an empty string', () => {
    expect(getHostname('')).toBe('unknown')
  })
})

describe('extractBody', () => {
  it('returns null for null', () => {
    expect(extractBody(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(extractBody(undefined)).toBeNull()
  })

  it('returns a plain string body as-is', () => {
    expect(extractBody('{"key":"value"}')).toBe('{"key":"value"}')
  })

  it('truncates a string body longer than 50000 chars', () => {
    const long = 'x'.repeat(60000)
    const result = extractBody(long)
    expect(result).toHaveLength(50000)
  })

  it('serialises URLSearchParams to query string', () => {
    const params = new URLSearchParams({ foo: 'bar', baz: 'qux' })
    expect(extractBody(params)).toBe('foo=bar&baz=qux')
  })

  it('returns "[FormData]" for FormData', () => {
    expect(extractBody(new FormData())).toBe('[FormData]')
  })

  it('returns "[Binary]" for ArrayBuffer', () => {
    expect(extractBody(new ArrayBuffer(8))).toBe('[Binary]')
  })
})

describe('getTabHostname', () => {
  it('extracts hostname from a normal HTTP URL', () => {
    expect(getTabHostname({ url: 'https://example.com/path?q=1' })).toBe('example.com')
  })

  it('extracts hostname from a subdomain URL', () => {
    expect(getTabHostname({ url: 'https://api.example.com' })).toBe('api.example.com')
  })

  it('extracts hostname from localhost with port', () => {
    expect(getTabHostname({ url: 'http://localhost:3000/app' })).toBe('localhost')
  })

  it('returns empty string when tab is undefined', () => {
    expect(getTabHostname(undefined)).toBe('')
  })

  it('returns empty string when tab has no url property', () => {
    expect(getTabHostname({})).toBe('')
  })

  it('returns empty string for an invalid URL', () => {
    expect(getTabHostname({ url: 'not a url' })).toBe('')
  })

  it('returns empty string for an empty url string', () => {
    expect(getTabHostname({ url: '' })).toBe('')
  })
})

describe('safeReadResponseText', () => {
  it('returns responseText when responseType is empty string', () => {
    expect(safeReadResponseText('', '{"ok":true}')).toBe('{"ok":true}')
  })

  it('returns responseText when responseType is "text"', () => {
    expect(safeReadResponseText('text', 'hello')).toBe('hello')
  })

  it('returns null for responseType "arraybuffer"', () => {
    expect(safeReadResponseText('arraybuffer', '')).toBeNull()
  })

  it('returns null for responseType "blob"', () => {
    expect(safeReadResponseText('blob', '')).toBeNull()
  })

  it('returns null for responseType "json"', () => {
    expect(safeReadResponseText('json', '{"x":1}')).toBeNull()
  })

  it('truncates responseText longer than 50000 characters', () => {
    const long = 'a'.repeat(60000)
    expect(safeReadResponseText('', long)).toHaveLength(50000)
    expect(safeReadResponseText('text', long)).toHaveLength(50000)
  })

  it('returns empty string for empty responseText when responseType is readable', () => {
    expect(safeReadResponseText('', '')).toBe('')
    expect(safeReadResponseText('text', '')).toBe('')
  })
})
