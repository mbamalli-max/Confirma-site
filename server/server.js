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

async function registerRouteGroup(app, name, registerFn) {
  try {
    await registerFn(app);
  } catch (error) {
    app.log.error({ err: error, route_group: name }, "Route registration failed; continuing startup");
  }
}

async function main() {
  const app = Fastify({ logger: true });
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : ["https://konfirmata.com", "https://www.konfirmata.com"];

  if (process.env.NODE_ENV !== "production") {
    allowedOrigins.push(
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5500",
      "http://127.0.0.1:5500"
    );
  }

  try {
    validateRuntimeConfig();
  } catch (err) {
    if (err?.fatal || (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_OTP !== "true")) {
      console.error("Fatal config error:", err.message);
      process.exit(1);
    } else {
      console.warn("Config warnings (non-fatal):", err.message);
    }
  }

  app.log.info(getAuthDeliverySummary(), "Auth delivery config");

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Device-Identity"]
  });

  await app.register(rateLimit, {
    global: false
  });

  app.get("/health", async (request, reply) => {
    return reply.send({
      status: "ok",
      service: "konfirmata-sync-server",
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV || "development"
    });
  });

  await registerRouteGroup(app, "auth", registerAuthRoutes);
  await registerRouteGroup(app, "account", registerAccountRoutes);
  await registerRouteGroup(app, "sync", registerSyncRoutes);
  await registerRouteGroup(app, "identity", registerIdentityRoutes);
  await registerRouteGroup(app, "attest", registerAttestRoutes);
  await registerRouteGroup(app, "payment", registerPaymentRoutes);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
