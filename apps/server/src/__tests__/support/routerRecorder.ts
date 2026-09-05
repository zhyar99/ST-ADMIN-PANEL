import express from 'express';

/**
 * Records where every Express router is mounted, as it is mounted.
 *
 * Express 5 drops the mount path once a router is attached — a Layer keeps a
 * compiled matcher and nothing else — so a router's full path cannot be
 * recovered by walking `app.router` afterwards. The prefix is therefore
 * captured at registration time by patching the shared Router prototype.
 *
 * Importing this module is what installs the patch, so it must be imported
 * *before* any module that creates a router. Import order is the mechanism, and
 * it is why the route-coverage suite imports this file first.
 */

type Handler = (...args: unknown[]) => unknown;

export type Registration =
  | { kind: 'route'; method: string; path: string }
  | { kind: 'mount'; path: string; child: object };

export interface DiscoveredRoute {
  method: string;
  path: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'] as const;

const registrations = new Map<object, Registration[]>();
const originals = new Map<string, Handler>();

const routerPrototype = Object.getPrototypeOf(Object.getPrototypeOf(express.Router())) as Record<
  string,
  Handler
>;

function record(owner: object, registration: Registration): void {
  const existing = registrations.get(owner) ?? [];
  existing.push(registration);
  registrations.set(owner, existing);
}

/** A mounted router, as opposed to a plain middleware function. */
function isRouter(value: unknown): value is object {
  return typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);
}

originals.set('use', routerPrototype.use as Handler);
routerPrototype.use = function patchedUse(this: object, ...args: unknown[]) {
  const [first] = args;

  if (typeof first === 'string') {
    for (const handler of args.slice(1)) {
      if (isRouter(handler)) record(this, { kind: 'mount', path: first, child: handler });
    }
  }

  return originals.get('use')!.apply(this, args);
};

for (const method of HTTP_METHODS) {
  originals.set(method, routerPrototype[method] as Handler);

  routerPrototype[method] = function patchedMethod(this: object, ...args: unknown[]) {
    const [first] = args;

    // `router.get('setting')` is the one-argument settings getter, not a route.
    if (typeof first === 'string' && args.length > 1) {
      record(this, { kind: 'route', method: method.toUpperCase(), path: first });
    }

    return originals.get(method)!.apply(this, args);
  };
}

/** Puts the Router prototype back. Call once every router has been created. */
export function restoreRouterPrototype(): void {
  for (const [name, original] of originals) routerPrototype[name] = original;
}

/** Every route reachable under `router`, as absolute paths below `prefix`. */
export function routesUnder(router: object, prefix: string): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];

  const walk = (current: object, at: string): void => {
    for (const registration of registrations.get(current) ?? []) {
      const segment = registration.path === '/' ? '' : registration.path;

      if (registration.kind === 'route') {
        found.push({ method: registration.method, path: `${at}${segment}` || '/' });
      } else {
        walk(registration.child, `${at}${segment}`);
      }
    }
  };

  walk(router, prefix);
  return found;
}
