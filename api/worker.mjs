// Cloudflare Worker entry. Configure with wrangler.toml [vars]. The x402 API holds no key.
// The NEAR AI Agent Market backend (near.mjs) needs two secrets set with `wrangler secret put`:
// NEAR_MARKET_TOKEN (the agent's aat_ token) and NEAR_WEBHOOK_SECRET; without them it is off.
import { configFrom, createApp } from "./app.mjs";
import { nearDeps, pollOnce } from "./near.mjs";

let app, cfg;
const init = (env) => {
  cfg ??= configFrom(env);
  app ??= createApp(cfg);
  return app;
};

export default {
  fetch(request, env, ctx) {
    return init(env).fetch(request, env, ctx);
  },
  // Cron (wrangler.toml [triggers]): pick up assignments whose webhook was missed, and keep
  // the agent's liveness stamp fresh so the marketplace routes paid calls to it.
  scheduled(event, env, ctx) {
    const a = init(env);
    const deps = nearDeps(env, cfg, a.provider);
    if (deps) ctx.waitUntil(pollOnce(deps).catch(() => {}));
  },
};
