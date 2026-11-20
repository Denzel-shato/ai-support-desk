// Query support for the in-memory Firestore (tests/fake-firestore.ts), written to follow the REAL
// semantics that matter for paging, not a convenient approximation:
//  - orderBy(field) silently EXCLUDES documents that lack the field (as Firestore does);
//  - values sort by type first (null < boolean < number < Timestamp < string), then by value;
//  - orderBy(FieldPath.documentId()) orders by the document ID (byte order);
//  - startAfter(snapshot) resumes strictly after that document in the full ordering;
//  - limit, select (projection) and count() (aggregation) are supported.
// It is still an in-memory simulation: it says nothing about real indexes, latency or billing.
import { FakeCollection, FakeFirestore } from "./fake-firestore";

type Order = { field: string | typeof DOC_ID; dir: "asc" | "desc" };
const DOC_ID = Symbol("documentId");

// structuredClone (used when seeding) drops the Timestamp prototype, leaving {_seconds,_nanoseconds}; real Firestore keeps a Timestamp.
function tsMillis(v: unknown): number | null {
  if (v && typeof v === "object") {
    const o = v as { toMillis?: () => number; _seconds?: unknown; _nanoseconds?: unknown };
    if (typeof o.toMillis === "function") return o.toMillis();
    if (typeof o._seconds === "number" && typeof o._nanoseconds === "number") return o._seconds * 1000 + o._nanoseconds / 1e6;
  }
  return null;
}
function typeRank(v: unknown): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (tsMillis(v) !== null) return 3;
  if (typeof v === "string") return 4;
  return 9;
}
function cmpValues(a: unknown, b: unknown): number {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return tsMillis(a)! - tsMillis(b)!;
  if (ra === 2 || ra === 1) return Number(a) - Number(b);
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface QueryLog { orderBy: string[]; startAfter: string | null; limit: number | null; select: string[] | null; kind: "get" | "count" }

export class FakeQuery {
  constructor(
    private col: FakeCollection,
    private orders: Order[] = [],
    private after: { id: string; data: Record<string, unknown> } | null = null,
    private max: number | null = null,
    private fields: string[] | null = null,
  ) {}

  orderBy(field: unknown, dir: "asc" | "desc" = "asc") {
    const f =
      field && typeof field === "object" && String(field) === "__name__"
        ? DOC_ID
        : String(field);
    return new FakeQuery(this.col, [...this.orders, { field: f, dir }], this.after, this.max, this.fields);
  }
  startAfter(snap: { id: string; data(): Record<string, unknown> | undefined }) {
    if (!snap || typeof snap.id !== "string") throw new Error("startAfter needs a DocumentSnapshot in this fake");
    return new FakeQuery(this.col, this.orders, { id: snap.id, data: snap.data() ?? {} }, this.max, this.fields);
  }
  limit(n: number) { return new FakeQuery(this.col, this.orders, this.after, n, this.fields); }
  select(...f: string[]) { return new FakeQuery(this.col, this.orders, this.after, this.max, f); }

  private rows() {
    const prefix = `${this.col.path}/`;
    const db = this.col.db as FakeFirestore & { queryLog?: QueryLog[] };
    let rows = [...db.data.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => ({ id: p.slice(prefix.length), path: p, data: db.data.get(p)! }));
    // Firestore drops documents that lack an ordered field.
    for (const o of this.orders) if (o.field !== DOC_ID) rows = rows.filter((r) => o.field in r.data && r.data[o.field as string] !== undefined);
    const orders = this.orders.length ? this.orders : [{ field: DOC_ID, dir: "asc" as const }];
    const cmp = (a: typeof rows[number], b: typeof rows[number]) => {
      for (const o of orders) {
        const c = o.field === DOC_ID ? cmpValues(a.id, b.id) : cmpValues(a.data[o.field as string], b.data[o.field as string]);
        if (c) return o.dir === "desc" ? -c : c;
      }
      return 0;
    };
    rows.sort(cmp);
    if (this.after) {
      const anchor = { id: this.after.id, path: "", data: this.after.data };
      rows = rows.filter((r) => cmp(r, anchor) > 0);
    }
    return rows;
  }

  async get() {
    const db = this.col.db as FakeFirestore & { queryLog?: QueryLog[] };
    db.queryLog?.push({ orderBy: this.orders.map((o) => `${o.field === DOC_ID ? "__name__" : String(o.field)} ${o.dir}`), startAfter: this.after?.id ?? null, limit: this.max, select: this.fields, kind: "get" });
    let rows = this.rows();
    if (this.max !== null) rows = rows.slice(0, this.max);
    const docs = rows.map((r) => {
      return makeSnap(this.col.db, r.path, this.fields);
    });
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  count() {
    return {
      get: async () => {
        const db = this.col.db as FakeFirestore & { queryLog?: QueryLog[] };
        db.queryLog?.push({ orderBy: this.orders.map((o) => `${o.field === DOC_ID ? "__name__" : String(o.field)} ${o.dir}`), startAfter: null, limit: null, select: null, kind: "count" });
        return { data: () => ({ count: this.rows().length }) };
      },
    };
  }
}

function makeSnap(db: FakeFirestore, path: string, fields: string[] | null) {
  const id = path.split("/").pop()!;
  return {
    id,
    path,
    exists: true,
    data() {
      const v = db.data.get(path);
      if (!v) return undefined;
      const full = structuredClone(v);
      if (!fields) return full;
      return Object.fromEntries(Object.entries(full).filter(([k]) => fields.includes(k)));
    },
  };
}

/** Adds orderBy / startAfter / select / count / a query log to a FakeFirestore collection. */
export function withQueries(db: FakeFirestore): FakeFirestore & { queryLog: QueryLog[] } {
  const patched = db as FakeFirestore & { queryLog: QueryLog[] };
  patched.queryLog = [];
  const original = db.collection.bind(db);
  db.collection = ((path: string) => {
    const col = original(path);
    const q = () => new FakeQuery(col);
    return Object.assign(col, {
      orderBy: (f: unknown, d?: "asc" | "desc") => q().orderBy(f, d),
      select: (...f: string[]) => q().select(...f),
      count: () => q().count(),
      limit: (n: number) => q().limit(n),
    });
  }) as typeof db.collection;
  return patched;
}
