/** Minimal React surface: the DSH client loader supplies the real module. */
declare module "react" {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
  export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
}