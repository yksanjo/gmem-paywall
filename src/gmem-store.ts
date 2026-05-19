/**
 * In-process wrapper around the gmem Store. The published @yksanjo/gmem
 * npm package only exports the MCP stdio server binary — but the Store
 * class itself is also exported as the package's `dist/db.js` for direct
 * embedding, which is what we use here.
 *
 * If a future gmem release stops shipping the Store as a public export,
 * we'd spawn the stdio binary and pipe JSON-RPC instead. For v0.1 the
 * direct embed is the simpler path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gmemMod = (await import("@yksanjo/gmem/dist/db.js" as any)) as {
  Store: new (path?: string) => GmemStoreLike;
  resolveDbPath: () => string;
};

export interface GmemStoreLike {
  write(kind: string, entity: Record<string, unknown>): { id: string; version: number };
  recall(query: string, kinds?: readonly string[], limit?: number): unknown[];
  listDecisions(limit?: number): Record<string, unknown>[];
  close(): void;
}

export interface GmemHost {
  write: GmemStoreLike["write"];
  recall: GmemStoreLike["recall"];
  listDecisions: GmemStoreLike["listDecisions"];
}

export async function openHost(): Promise<GmemHost> {
  const path = process.env.GMEM_DB?.trim() || gmemMod.resolveDbPath();
  const store = new gmemMod.Store(path);
  return {
    write: store.write.bind(store),
    recall: store.recall.bind(store),
    listDecisions: store.listDecisions.bind(store),
  };
}
