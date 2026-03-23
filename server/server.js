import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./src/config.js";
import { registerAuthRoutes } from "./src/routes/auth.js";
import { registerSyncRoutes } from "./src/routes/sync.js";
import { registerIdentityRoutes } from "./src/routes/identity.js";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

app.get("/health", async () => ({
  ok: true,
  service: "confirma-sync-server",
  now: new Date().toISOString()
}));

await registerAuthRoutes(app);
await registerSyncRoutes(app);
await registerIdentityRoutes(app);

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
