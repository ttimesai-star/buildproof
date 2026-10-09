// Cloudflare Worker entry. Configure with wrangler.toml [vars] (no secrets needed:
// the service holds no private key).
import { configFrom, createApp } from "./app.mjs";

let app;
export default {
  fetch(request, env, ctx) {
    app ??= createApp(configFrom(env));
    return app.fetch(request, env, ctx);
  },
};
