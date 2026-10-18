import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { openApiSpec } from '../openapi';

/**
 * Routes that are intentionally not documented in the OpenAPI spec.
 * Add entries here (in OpenAPI style, e.g. "/foo/{id}") when a route is
 * deliberately left out of the spec.
 */
const EXCLUDED_ROUTES = new Set<string>([
  '/openapi.json',
  '/docs',
  '/docs/json',
  '/metrics',
]);

interface RouteEntry {
  method: string;
  path: string;
}

/**
 * Normalize an Express path to OpenAPI style:
 *   "/users/:id" -> "/users/{id}"
 */
function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Walk the Express router stack and collect all registered method+path pairs.
 */
function collectRoutes(app: ReturnType<typeof createApp>): RouteEntry[] {
  const routes: RouteEntry[] = [];

  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        // A route layer
        const routePath = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        const methods = Object.keys(layer.route.methods || {});
        for (const method of methods) {
          if (method === '_all') {
            continue;
          }
          routes.push({
            method: method.toUpperCase(),
            path: normalizePath(routePath || '/'),
          });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // A nested router; derive its mount path from the layer's regexp.
        const mountPath = getMountPath(layer);
        walk(layer.handle.stack, prefix + mountPath);
      }
    }
  };

  const router = (app as any)._router ?? (app as any).router;
  if (router && Array.isArray(router.stack)) {
    walk(router.stack, '');
  }

  return routes;
}

/**
 * Extract the mount path from an Express router layer.
 * Express stores the mount path in `layer.regexp`; we reconstruct it.
 */
function getMountPath(layer: any): string {
  if (typeof layer.path === 'string') {
    return layer.path === '/' ? '' : layer.path;
  }

  const regexp: RegExp | undefined = layer.regexp;
  if (!regexp) {
    return '';
  }

  // Try to recover the literal prefix from the regexp source.
  // Express generates something like: ^\/api\/?(?=\/|$)
  const source = regexp.source;
  const match = source.match(/^\^\\\/(.*?)\\\/\?\(\?=/);
  if (match) {
    return '/' + match[1].replace(/\\\//g, '/');
  }

  // Fallback: strip anchors and optional trailing slash markers.
  const cleaned = source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\/\?\(\?=\/\|\$\)$/, '')
    .replace(/\(\?:\\\/\)\?$/, '')
    .replace(/\/\?$/, '');

  if (cleaned === '' || cleaned === '/') {
    return '';
  }

  return cleaned.startsWith('/') ? cleaned : '/' + cleaned;
}

/**
 * Collect all documented method+path pairs from the OpenAPI spec.
 */
function collectSpecRoutes(): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const paths = openApiSpec.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) {
      continue;
    }
    for (const method of Object.keys(pathItem)) {
      const upper = method.toUpperCase();
      // Only count actual HTTP methods.
      if (
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(
          upper,
        )
      ) {
        routes.push({ method: upper, path });
      }
    }
  }

  return routes;
}

function routeKey(route: RouteEntry): string {
  return `${route.method} ${route.path}`;
}

describe('OpenAPI spec matches registered routes', () => {
  const app = createApp();
  const registeredRoutes = collectRoutes(app).filter(
    (route) => !EXCLUDED_ROUTES.has(route.path),
  );
  const specRoutes = collectSpecRoutes();

  const registeredKeys = new Set(registeredRoutes.map(routeKey));
  const specKeys = new Set(specRoutes.map(routeKey));

  it('documents every registered route', () => {
    const missingFromSpec = [...registeredKeys]
      .filter((key) => !specKeys.has(key))
      .sort();

    expect(
      missingFromSpec,
      `Routes registered in Express but missing from the OpenAPI spec:\n` +
        missingFromSpec.map((key) => `  - ${key}`).join('\n'),
    ).toEqual([]);
  });

  it('does not document routes that are not registered', () => {
    const extraInSpec = [...specKeys]
      .filter((key) => !registeredKeys.has(key))
      .sort();

    expect(
      extraInSpec,
      `Routes documented in the OpenAPI spec but not registered in Express:\n` +
        extraInSpec.map((key) => `  - ${key}`).join('\n'),
    ).toEqual([]);
  });
});