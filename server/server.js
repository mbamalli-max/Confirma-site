import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  config,
  createCorsDelegator,
  getAuthDeliverySummary,
  getProxyTrustSummary,
  validateRuntimeConfig
} from "./src/config.js";
import { registerAuthRoutes } from "./src/routes/auth.js";
import { registerSyncRoutes } from "./src/routes/sync.js";
import { registerIdentityRoutes } from "./src/routes/identity.js";
import { registerAttestRoutes } from "./src/routes/attest.js";
import { registerPaymentRoutes } from "./src/routes/payment.js";
import { registerAccountRoutes } from "./src/routes/account.js";
import { registerAdminAuthRoutes } from "./src/routes/admin/auth.js";
import { registerAdminClassificationRoutes } from "./src/routes/admin/classification.js";
import { registerAdminMetricsRoutes } from "./src/routes/admin/metrics.js";

async function registerRouteGroup(app, name, registerFn) {
  try {
    await registerFn(app);
  } catch (error) {
    app.log.error({ err: error, route_group: name }, "Route registration failed; continuing startup");
  }
}

async function registerRouteGroupStrict(app, name, registerFn) {
  try {
    await registerFn(app);
  } catch (error) {
    app.log.fatal({ err: error, route_group: name }, "Admin route registration failed; aborting startup");
    throw error;
  }
}

async function main() {
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

  const app = Fastify({
    logger: true,
    ...(config.trustProxy === undefined ? {} : { trustProxy: config.trustProxy })
  });

  app.log.info(getAuthDeliverySummary(), "Auth delivery config");
  app.log.info(getProxyTrustSummary(), "Proxy trust config");

  await app.register(cors, createCorsDelegator(allowedOrigins));

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
  await registerRouteGroupStrict(app, "admin-auth", registerAdminAuthRoutes);
  await registerRouteGroupStrict(app, "admin-classification", registerAdminClassificationRoutes);
  await registerRouteGroupStrict(app, "admin-metrics", registerAdminMetricsRoutes);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
