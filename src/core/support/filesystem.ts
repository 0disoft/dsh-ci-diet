import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";

/** One directory entry, reduced to the facts discovery needs. */
export interface FileSystemEntry {
  readonly name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The filesystem operations the core performs. Production uses node:fs; tests
 * can supply an in-memory implementation without touching the real disk.
 */
export interface FileSystem {
  realpath(path: string): string;
  readdir(path: string): readonly FileSystemEntry[];
  stat(path: string): { readonly size: number };
  readFile(path: string, encoding: "utf8"): string;
}

export const nodeFileSystem: FileSystem = {
  realpath: (path) => realpathSync.native(path),
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  stat: (path) => statSync(path),
  readFile: (path, encoding) => readFileSync(path, encoding),
};
