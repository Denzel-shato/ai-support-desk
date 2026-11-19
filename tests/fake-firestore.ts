// Minimal in-memory stand-in for the parts of Firestore the app uses:
// collections / docs / subcollections, get, create (fails if it exists),
// update (fails if missing), set, limit().get(), and runTransaction.
// Transactions here are serialised (one at a time), which models Firestore's
// guarantee that a conflicting transaction retries against fresh data.

class FakeTime {
  constructor(private ms: number) {}
  toDate() { return new Date(this.ms); }
  toMillis() { return this.ms; }
}

let clock = 1_700_000_000_000;

export class FakeFirestore {
  data = new Map<string, Record<string, unknown>>();
  times = new Map<string, number>();
  writes: { op: string; path: string }[] = [];
  failNext: { path: string; error: unknown } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  collection(path: string) { return new FakeCollection(this, path); }

  seed(path: string, value: Record<string, unknown>) {
    this.data.set(path, structuredClone(value));
    this.times.set(path, ++clock);
  }
  read(path: string) { return this.data.get(path); }

  _write(op: string, path: string, value: Record<string, unknown>) {
    this.writes.push({ op, path });
    this.data.set(path, value);
    this.times.set(path, ++clock);
  }

  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const pending: (() => void)[] = [];
      const tx = new FakeTx(this, pending);
      const result = await fn(tx);
      for (const apply of pending) apply();
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

class FakeTx {
  constructor(private db: FakeFirestore, private pending: (() => void)[]) {}
  async get(ref: FakeDoc) { return ref.get(); }
  update(ref: FakeDoc, fields: Record<string, unknown>) {
    this.pending.push(() => ref._update(fields));
  }
  create(ref: FakeDoc, value: Record<string, unknown>) {
    this.pending.push(() => ref._create(value));
  }
  set(ref: FakeDoc, value: Record<string, unknown>) {
    this.pending.push(() => this.db._write("set", ref.path, structuredClone(value)));
  }
}

export class FakeCollection {
  private counter = 0;
  constructor(public db: FakeFirestore, public path: string) {}
  doc(id?: string) { return new FakeDoc(this.db, `${this.path}/${id ?? `auto${++this.counter}_${Math.random().toString(36).slice(2, 8)}`}`); }
  limit(n: number) { return { get: () => this.get(n) }; }
  async get(max = Infinity) {
    const prefix = `${this.path}/`;
    const docs = [...this.db.data.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .slice(0, max)
      .map((p) => new FakeSnap(this.db, p));
    return { docs, size: docs.length };
  }
}

class FakeSnap {
  constructor(private db: FakeFirestore, public path: string) {}
  get id() { return this.path.split("/").pop()!; }
  get exists() { return this.db.data.has(this.path); }
  data() { const v = this.db.data.get(this.path); return v ? structuredClone(v) : undefined; }
  get updateTime() {
    const t = this.db.times.get(this.path);
    return t ? new FakeTime(t) : undefined;
  }
}

export class FakeDoc {
  constructor(public db: FakeFirestore, public path: string) {}
  get id() { return this.path.split("/").pop()!; }
  collection(name: string) { return new FakeCollection(this.db, `${this.path}/${name}`); }
  async get() { return new FakeSnap(this.db, this.path); }
  async create(value: Record<string, unknown>) { return this._create(value); }
  async set(value: Record<string, unknown>) { this.db._write("set", this.path, structuredClone(value)); return {}; }
  _create(value: Record<string, unknown>) {
    if (this.db.data.has(this.path)) {
      throw Object.assign(new Error("ALREADY_EXISTS"), { code: 6 });
    }
    this.db._write("create", this.path, structuredClone(value));
    return { writeTime: new FakeTime(this.db.times.get(this.path)!) };
  }
  _update(fields: Record<string, unknown>) {
    const cur = this.db.data.get(this.path);
    if (!cur) throw Object.assign(new Error("NOT_FOUND"), { code: 5 });
    this.db._write("update", this.path, { ...cur, ...structuredClone(fields) });
  }
}
