// Fake fetch: routes are [match, response] pairs. match is a URL prefix or a
// predicate (url, init) => boolean.
export function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    for (const [match, res] of routes) {
      if (typeof match === 'string' ? url.startsWith(match) : match(url, init)) {
        const r = typeof res === 'function' ? res(url, init) : res;
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
        return { status: r.status, url, text: async () => body };
      }
    }
    return { status: 599, url, text: async () => 'no route' };
  };
}

export const BOOTSTRAP = {
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
    [['ai'], ['https://rdap.identitydigital.services/rdap/']],
  ],
};

export const fixedClock = () => new Date('2026-10-15T08:00:00.123Z');
