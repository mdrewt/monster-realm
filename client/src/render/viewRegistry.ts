// render/viewRegistry.ts — pooled-view lifecycle bookkeeping (M4b). PURE.
//
// The renderer keeps ONE CharacterView per entity (sprite pooling: mutate-in-place,
// never recreate per frame), and tears a view down when its row despawns (no leaked
// views / ghost sprites). This is the pure decision core of that: given the set of
// entity ids that SHOULD have a view this frame, it returns which ids are newly
// `created` and which are `removed` (despawned), and tracks the present set. The
// Pixi sprite alloc/free is the (untested-here) shell that applies the diff.

export class ViewRegistry {
  #present = new Set<bigint>();

  /** Diff `desired` against the present set; return the create/remove work and
   *  advance the present set to `desired`. Idempotent on a stable frame. */
  reconcile(desired: Iterable<bigint>): { readonly created: bigint[]; readonly removed: bigint[] } {
    const want = new Set(desired);
    const created: bigint[] = [];
    const removed: bigint[] = [];
    for (const id of want) {
      if (!this.#present.has(id)) created.push(id);
    }
    for (const id of this.#present) {
      if (!want.has(id)) removed.push(id);
    }
    this.#present = want;
    return { created, removed };
  }

  has(id: bigint): boolean {
    return this.#present.has(id);
  }

  get size(): number {
    return this.#present.size;
  }
}
