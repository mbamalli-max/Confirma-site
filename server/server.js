import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config, getAuthDeliverySummary, validateRuntimeConfig } from "./src/config.js";
import { registerAuthRoutes } from "./src/routes/auth.js";
import { registerSyncRoutes } from "./src/routes/sync.js";
import { registerIdentityRoutes } from "./src/routes/identity.js";
import { registerAttestRoutes } from "./src/routes/attest.js";
import { registerPaymentRoutes } from "./src/routes/payment.js";
import { registerAccountRoutes } from "./src/routes/account.js";

async function main() {
  validateRuntimeConfig();
  const app = Fastify({ logger: true });

  app.log.info(getAuthDeliverySummary(), "Auth delivery config");

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Device-Identity"]
  });

  await app.register(rateLimit, {
    global: false
  });

  app.get("/health", async () => ({
    ok: true,
    service: "konfirmata-sync",
    ts: new Date().toISOString()
  }));

  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerSyncRoutes(app);
  await registerIdentityRoutes(app);
  await registerAttestRoutes(app);
  await registerPaymentRoutes(app);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
