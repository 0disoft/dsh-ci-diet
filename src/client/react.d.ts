/** Minimal React surface: the DSH client loader supplies the real module. */
declare function setInterval(callback: () => void, milliseconds: number): number;
declare function clearInterval(handle: number): void;

declare module "react" {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
}
