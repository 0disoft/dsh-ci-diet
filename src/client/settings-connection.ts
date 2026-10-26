/** Resolve the current profile's CI Diet entry through DSH's public inventory. */
export interface FormSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value?: Record<string, unknown> | undefined;
  readonly user?: unknown;
  readonly revision?: number | undefined;
  readonly writable: boolean;
  readonly issue?: "missing" | "inactive" | "multiple" | "transport" | "form";
  readonly entryIds?: readonly string[];
}

export type SettingsPathOp =
  | { readonly op: "set"; readonly path: string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: string[] };

export interface ConfigForm {
  getSnapshot(): FormSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
  retry?(): void;
}

export interface ConfigForms {
  get(entryId: string): ConfigForm;
  describe?(): {
    getSnapshot(): { readonly view?: unknown; readonly error: string | null };
    subscribe(listener: () => void): () => void;
    ensure(): Promise<void>;
  };
}

interface InventoryConnection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
      { ok: true; value: unknown } | { ok: false; error: { message: string } }
    >;
  };
}

interface Entry {
  readonly entryId: string;
  readonly moduleName: string;
  readonly enabled: boolean;
  readonly fiberPhase: string | null;
}

function inventoryEntries(value: unknown): Entry[] {
  if (value === null || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
    throw new Error("INVALID_PLUGIN_INVENTORY");
  }
  return value.entries.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || !("entryId" in entry) || typeof entry.entryId !== "string" || !entry.entryId
      || !("moduleName" in entry) || typeof entry.moduleName !== "string" || !("enabled" in entry) || typeof entry.enabled !== "boolean"
      || !("fiberPhase" in entry) || (entry.fiberPhase !== null && typeof entry.fiberPhase !== "string")) {
      throw new Error("INVALID_PLUGIN_INVENTORY_ENTRY");
    }
    return entry as Entry;
  });
}

/** Map a Loader entry id to the settings namespace DSH serves for it.
 *
 * Bundle rows are nested under a synthetic include entry, so the public
 * inventory id is `include:<entry id>` while Settings keys the same row by
 * `<entry id>`. Prefer the served namespace when the describe mirror is
 * available, and fall back to the row id itself.
 */
export function settingsNamespace(entryId: string, view: unknown): string {
  const rowId = entryId.startsWith("include:") ? entryId.slice("include:".length) : entryId;
  if (view === null || typeof view !== "object" || !("namespaces" in view) || !Array.isArray(view.namespaces)) return rowId;
  const served = new Set<string>();
  for (const namespace of view.namespaces) {
    if (namespace !== null && typeof namespace === "object" && "ns" in namespace && typeof namespace.ns === "string") served.add(namespace.ns);
  }
  if (served.has(rowId)) return rowId;
  if (served.has(entryId)) return entryId;
  return rowId;
}

/** Keep the host form's atomic writes/revision fence; never infer ownership from settings values. */
export class SettingsConnection implements ConfigForm {
  private snapshot: FormSnapshot = { status: "loading", writable: false };
  private readonly listeners = new Set<() => void>();
  private form: ConfigForm | undefined;
  private entryId: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private mirrorOff: (() => void) | undefined;
  private pending = false;
  private started = false;
  private disposed = false;
  private abort: AbortController | undefined;

  private readonly forms: ConfigForms;
  private readonly connection: InventoryConnection;

  constructor(forms: ConfigForms, connection: InventoryConnection) {
    this.forms = forms;
    this.connection = connection;
  }

  getSnapshot(): FormSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  connect(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.retry();
  }

  retry(): void { void this.resolve(); }

  async mutate(ops: readonly SettingsPathOp[], revision?: number): Promise<boolean> {
    if (this.disposed || this.snapshot.status !== "ready" || !this.snapshot.writable || this.form === undefined) return false;
    return this.form.mutate(ops, revision);
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.unsubscribe?.();
    this.mirrorOff?.();
    this.listeners.clear();
  }

  private publish(snapshot: FormSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private fail(issue: NonNullable<FormSnapshot["issue"]>, entryIds: readonly string[] = []): void {
    this.publish({ status: "unavailable", writable: false, issue, entryIds });
  }

  private async resolve(): Promise<void> {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.mirrorOff?.(); this.mirrorOff = undefined;
    this.form = undefined;
    this.publish({ status: "loading", writable: false });
    try {
      this.abort = new AbortController();
      const result = await this.connection.rpc.call("/api", "pluginInventory/list", { args: {} },
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]));
      if (this.disposed) return;
      if (!result.ok) { this.fail("transport"); return; }
      const entries = inventoryEntries(result.value).filter((entry) => entry.moduleName === "dsh-ci-diet" || entry.moduleName.startsWith("dsh-ci-diet/"));
      const active = entries.filter((entry) => entry.enabled && entry.fiberPhase === "active");
      if (entries.length === 0) { this.fail("missing"); return; }
      if (active.length === 0) { this.fail("inactive", entries.map((entry) => entry.entryId)); return; }
      if (active.length !== 1) { this.fail("multiple", active.map((entry) => entry.entryId)); return; }
      const id = active[0]!.entryId;
      // A retry must not move an existing draft/revision onto a replacement entry.
      if (this.entryId !== undefined && this.entryId !== id) { this.fail("form", [id]); return; }
      this.entryId = id;
      const mirror = this.forms.describe?.();
      const namespace = settingsNamespace(id, mirror?.getSnapshot().view);
      this.form = this.forms.get(namespace);
      const sync = () => {
        const current = this.form!.getSnapshot();
        if (current.status === "unavailable") this.fail("form", [id]);
        else if (current.status === "loading" && mirror?.getSnapshot().error) this.fail("transport", [id]);
        else if (current.status === "loading" && mirror?.getSnapshot().view !== undefined) this.fail("form", [id]);
        else this.publish({ ...current, entryIds: [id] });
      };
      this.unsubscribe = this.form.subscribe(sync);
      this.mirrorOff = mirror?.subscribe(sync);
      // get() returns cached forms; retry their shared first-read after a failed connection.
      void mirror?.ensure().catch(() => this.fail("transport", [id]));
      sync();
    } catch {
      this.fail(this.entryId === undefined ? "transport" : "form", this.entryId === undefined ? [] : [this.entryId]);
    } finally { this.pending = false; }
  }
}
