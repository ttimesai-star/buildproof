# brand-name-checker

Read-only check of a brand name across domains, social handles, app stores and trademark registers, with the time of every check in the report.

It never registers, reserves or stores the names it checks. The only non-GET request it makes is the search query to the USPTO trademark index.

## What it checks

| Area | Source | "taken" means | "available" means |
|---|---|---|---|
| Domains | RDAP server of the registry (IANA bootstrap); WHOIS port 43 for ccTLDs without RDAP (.io, .co, .de, .by, ...) | registration record exists | registry has no record (premium or reserved names can still be blocked by the registry) |
| GitHub | `api.github.com/users/<h>` | user or org exists | 404 |
| X | `x.com/<h>` | profile URL resolves | 404 |
| Instagram | `web_profile_info` | public profile returned | 404 |
| TikTok | profile page | profile data present | TikTok status 10221 ("couldn't find this account") |
| YouTube | `youtube.com/@<h>` | handle resolves | 404 |
| Reddit | `username_available.json` | `false` | `true` |
| Bluesky | `resolveHandle` for `<h>.bsky.social` | resolves to a DID | "Unable to resolve handle" |
| Telegram | `t.me/<h>` | public page exists | never; private accounts look the same as free names |
| npm | registry | package exists | 404 |
| Apple App Store | iTunes Search API | an app with the same name | none in the results |
| Google Play | public search page | an app with the same name | "No results for" or none in the results |
| US trademarks | USPTO Trademark Search index (tmsearch.uspto.gov) | identical, near-identical (edit distance 1-2) or containing marks, with serial no., registration no., live/dead status, owner, classes | |
| Other trademark registers | not searched automatically | | the report names the database and gives a search link (EUIPO, UK IPO, WIPO Global Brand Database) |

Any other answer, such as a login wall, rate limit, bot challenge, network error or unknown page layout, is reported as **couldn't confirm** with the reason. The checker does not guess.

Suggested variations are offered only when they are confirmed free on every requested domain and platform in the same run. A "couldn't confirm" disqualifies a variation.

## Use

```bash
node bin/check.js Acme --tlds com,io,ai --platforms x,instagram,tiktok --tm US
node bin/check.js Acme Zentro Quorvela --variations 3 --json
```

As a library (Node 18+; also runs on Cloudflare Workers if you pass a WHOIS transport built on `cloudflare:sockets`):

```js
import { checkNames, renderReport } from './src/index.js';
import { whoisNode } from './src/whois-node.js';

const res = await checkNames({ names: ['Acme'], tlds: ['com', 'io'], platforms: ['x', 'github'], trademarkCountries: ['US'] }, { whois: whoisNode });
console.log(renderReport(res));
```

## Tests

```bash
npm test
```

The tests use a fake `fetch` and need no network.

## Limits

- Availability can change at any moment; results hold only at the time shown.
- Instagram, TikTok, X and Reddit throttle or block automated lookups from some networks. When that happens the report says "couldn't confirm".
- Trademark results are a starting point, not legal advice.

## Disclosure

Written with an AI coding agent (Claude) and reviewed before release.

## License

MIT
