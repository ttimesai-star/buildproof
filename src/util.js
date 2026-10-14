// Shared helpers. No dependencies: runs on Node 18+ and Cloudflare Workers.

export const STATUS = Object.freeze({
  AVAILABLE: 'available',
  TAKEN: 'taken',
  UNCONFIRMED: "couldn't confirm",
});

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export function nowIso(clock = () => new Date()) {
  return clock().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Lower-case, strip accents and everything that is not a letter or digit.
export function normalize(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Handle form of a name: letters, digits and underscore only.
export function toHandle(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

// Domain label form of a name (LDH rule, no leading/trailing hyphen).
export function toLabel(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// Fetch with a timeout. Never throws: network errors come back as {status: -1}.
export async function safeFetch(fetchImpl, url, init = {}, timeoutMs = 15000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      ...init,
      headers: { 'User-Agent': UA, ...(init.headers || {}) },
      signal: ctrl ? ctrl.signal : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, url: res.url || url };
  } catch (err) {
    return { status: -1, text: String(err && err.message ? err.message : err), url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
