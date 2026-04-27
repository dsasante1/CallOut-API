export function escHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBody(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
  }
  return text;
}

export function getHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

export function extractBody(body: BodyInit | null | undefined): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body.slice(0, 50000);
  if (body instanceof URLSearchParams) return body.toString().slice(0, 50000);
  if (body instanceof FormData) return '[FormData]';
  return '[Binary]';
}
