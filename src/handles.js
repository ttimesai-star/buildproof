// Exact-handle checks on public profile endpoints. "taken" only when the
// platform shows the profile; "available" only on an explicit not-found
// answer; anything else (login wall, rate limit, block) is "couldn't confirm".

import { STATUS, nowIso, safeFetch } from './util.js';

const ok = (status, detail) => ({ status, detail });

export const PLATFORMS = {
  github: {
    label: 'GitHub',
    url: (h) => `https://api.github.com/users/${h}`,
    profile: (h) => `https://github.com/${h}`,
    headers: { Accept: 'application/vnd.github+json' },
    classify: (r) =>
      r.status === 200 ? ok(STATUS.TAKEN, 'user or organization exists')
        : r.status === 404 ? ok(STATUS.AVAILABLE, 'no user or organization with this login')
          : ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`),
  },
  x: {
    label: 'X (Twitter)',
    url: (h) => `https://x.com/${h}`,
    profile: (h) => `https://x.com/${h}`,
    classify: (r) =>
      r.status === 200 ? ok(STATUS.TAKEN, 'profile URL resolves (live or suspended account)')
        : r.status === 404 ? ok(STATUS.AVAILABLE, 'profile URL returns 404')
          : ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`),
  },
  instagram: {
    label: 'Instagram',
    url: (h) => `https://www.instagram.com/api/v1/users/web_profile_info/?username=${h}`,
    profile: (h) => `https://www.instagram.com/${h}/`,
    headers: { 'x-ig-app-id': '936619743392459' },
    classify: (r, h) => {
      if (r.status === 200) {
        try {
          const u = JSON.parse(r.text)?.data?.user;
          if (u && String(u.username).toLowerCase() === h) return ok(STATUS.TAKEN, 'public profile returned');
        } catch { /* fall through */ }
        return ok(STATUS.UNCONFIRMED, 'unexpected profile response');
      }
      if (r.status === 404) return ok(STATUS.AVAILABLE, 'profile lookup returns 404 (reserved or banned names can still be blocked)');
      return ok(STATUS.UNCONFIRMED, `Instagram blocked the lookup (HTTP ${r.status}); no public availability check exists`);
    },
  },
  tiktok: {
    label: 'TikTok',
    url: (h) => `https://www.tiktok.com/@${h}`,
    profile: (h) => `https://www.tiktok.com/@${h}`,
    classify: (r, h) => {
      if (r.status !== 200) return ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`);
      if (r.text.includes(`"uniqueId":"${h}"`)) return ok(STATUS.TAKEN, 'profile data present');
      if (/"statusCode":10221\b/.test(r.text)) return ok(STATUS.AVAILABLE, "TikTok reports \"couldn't find this account\" (banned names can still be blocked)");
      return ok(STATUS.UNCONFIRMED, 'TikTok returned a page without profile data; no public availability check exists');
    },
  },
  youtube: {
    label: 'YouTube',
    url: (h) => `https://www.youtube.com/@${h}`,
    profile: (h) => `https://www.youtube.com/@${h}`,
    classify: (r) =>
      r.status === 200 ? ok(STATUS.TAKEN, 'channel handle resolves')
        : r.status === 404 ? ok(STATUS.AVAILABLE, 'handle URL returns 404')
          : ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`),
  },
  reddit: {
    label: 'Reddit',
    url: (h) => `https://www.reddit.com/api/username_available.json?user=${h}`,
    profile: (h) => `https://www.reddit.com/user/${h}`,
    classify: (r) => {
      if (r.status === 200 && /^\s*true\s*$/.test(r.text)) return ok(STATUS.AVAILABLE, 'Reddit username_available = true');
      if (r.status === 200 && /^\s*false\s*$/.test(r.text)) return ok(STATUS.TAKEN, 'Reddit username_available = false');
      return ok(STATUS.UNCONFIRMED, `Reddit blocked the lookup (HTTP ${r.status})`);
    },
  },
  bluesky: {
    label: 'Bluesky',
    url: (h) => `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${h}.bsky.social`,
    profile: (h) => `https://bsky.app/profile/${h}.bsky.social`,
    classify: (r) =>
      r.status === 200 && r.text.includes('"did"') ? ok(STATUS.TAKEN, 'handle resolves to a DID')
        : r.status === 400 && /Unable to resolve handle/i.test(r.text) ? ok(STATUS.AVAILABLE, 'handle does not resolve')
          : ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`),
  },
  telegram: {
    label: 'Telegram',
    url: (h) => `https://t.me/${h}`,
    profile: (h) => `https://t.me/${h}`,
    classify: (r) =>
      r.status === 200 && r.text.includes('tgme_page_title') ? ok(STATUS.TAKEN, 'public user, channel or bot page exists')
        : ok(STATUS.UNCONFIRMED, 'no public page; private accounts and reserved names look the same'),
  },
  npm: {
    label: 'npm',
    url: (h) => `https://registry.npmjs.org/${h}`,
    profile: (h) => `https://www.npmjs.com/package/${h}`,
    classify: (r) =>
      r.status === 200 ? ok(STATUS.TAKEN, 'package exists')
        : r.status === 404 ? ok(STATUS.AVAILABLE, 'no package with this name (npm may still reject names too similar to existing ones)')
          : ok(STATUS.UNCONFIRMED, `HTTP ${r.status}`),
  },
};

export const DEFAULT_PLATFORMS = ['x', 'instagram', 'tiktok', 'youtube', 'github', 'reddit'];

export async function checkHandle(handle, platform, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const p = PLATFORMS[platform];
  if (!p) {
    return { kind: 'handle', platform, target: handle, status: STATUS.UNCONFIRMED, detail: 'platform not supported', checkedAt: nowIso(deps.clock) };
  }
  const h = handle.toLowerCase();
  const r = await safeFetch(fetchImpl, p.url(h), { headers: p.headers || {} });
  const { status, detail } = r.status === -1 ? ok(STATUS.UNCONFIRMED, `network error: ${r.text}`) : p.classify(r, h);
  return { kind: 'handle', platform, label: p.label, target: h, status, detail, link: p.profile(h), checkedAt: nowIso(deps.clock) };
}
