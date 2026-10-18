import express, { type Express, type Request } from "express";
import compression from "compression";
import { config } from "./config.js";
import { corsMiddleware } from "./cors.js";
import { securityHeaders } from "./middleware/security.js";
import { requestContextMiddleware } from "./middleware/requestContext.js";
import { auditLogMiddleware } from "./middleware/auditLog.js";
import { inFlightMiddleware } from "./middleware/inFlight.js";
import { requestTimeout } from "./middleware/timeout.js";
import { requestDurationMiddleware } from "./middleware/requestDuration.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRouter from "./routes/health.js";
import publisherRouter from "./routes/publishers.js";
import registryRouter from "./routes/registry.js";
import resourceRouter from "./routes/resources.js";
import verifyRouter from "./routes/verify.js";
import paymentsRouter from "./routes/payments.js";
import docsRouter from "./routes/docs.js";
import metricsRouter from "./routes/metrics.js";
import adminRouter from "./routes/admin.js";

export function createApp(): Express {
  const app = express();

  if (config.NODE_ENV === "production" && config.TRUST_PROXY !== undefined) {
    app.set("trust proxy", config.TRUST_PROXY);
  }

  app.use(securityHeaders());
  app.use(compression());
  app.use(corsMiddleware());
  app.use(requestContextMiddleware);
  app.use(auditLogMiddleware);
  app.use(inFlightMiddleware);
  app.use(
    express.json({
      limit: config.MAX_JSON_BODY_SIZE,
      // Keep the exact bytes so request signatures can hash what the client signed.
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(requestTimeout(config.REQUEST_TIMEOUT_MS));
  app.use(requestDurationMiddleware);

  // Routes
  app.use(healthRouter);
  app.use(publisherRouter);
  app.use(registryRouter);
  app.use(resourceRouter);
  app.use(verifyRouter);
  app.use(paymentsRouter);
  app.use(metricsRouter);
  app.use(adminRouter);

  // OpenAPI spec + Swagger UI (all envs; UI is CDN-based, no extra package needed)
  app.use(docsRouter);

  // 404 handler (after all routes)
  app.use(notFoundHandler);

  // Global error handler
  app.use(errorHandler);

  return app;
}
