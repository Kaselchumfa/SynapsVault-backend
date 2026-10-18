import type { Request, Response, NextFunction } from "express";
import { getLogger } from "../lib/logger.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function auditLogMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const log     = getLogger();
  const started = Date.now();
  res.on("finish", () => {
    log.info({
      event:       "audit",
      method:      req.method,
      path:        req.path,
      statusCode:  res.statusCode,
      durationMs:  Date.now() - started,
      publisherId: ((req as unknown as Record<string, {id:string}>).publisher?.id
        ?? null),
      ip: req.ip,
    });
  });
  next();
}