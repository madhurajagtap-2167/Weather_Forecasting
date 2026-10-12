/** Tiny in-memory stand-in for the parts of the MongoDB driver this project uses. */
const get = (o, k) => o[k];
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, x]) => ({
        $gte: v >= x, $gt: v > x, $lt: v < x, $lte: v <= x, $eq: v === x,
      }[op]));
    }
    return v === cond;
  });
}
class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) {
    const [[k, dir]] = Object.entries(spec);
    this.docs.sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
    return this;
  }
  async toArray() { return this.docs; }
}
const project = (doc, projection = {}) => {
  const out = { ...doc };
  for (const [k, v] of Object.entries(projection)) if (v === 0) delete out[k];
  return out;
};
class Collection {
  constructor() { this.docs = []; this.uniq = []; this.idx = new Map(); }
  async createIndex(keys, opts = {}) { if (opts.unique) this.uniq.push(Object.keys(keys)); }
  _find(filter) { return this.docs.find((d) => matches(d, filter)); }
  async bulkWrite(ops) {
    for (const op of ops) {
      const { filter, update, upsert } = op.updateOne;
      const key = JSON.stringify(filter);
      const hit = this.idx.get(key);
      if (hit) Object.assign(hit, update.$set);
      else if (upsert) { const d = { ...filter, ...update.$set }; this.docs.push(d); this.idx.set(key, d); }
    }
  }
  find(filter = {}, opts = {}) {
    return new Cursor(this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts.projection)));
  }
  async findOne(filter, opts = {}) { const d = this._find(filter); return d ? project(d, opts.projection) : null; }
  async replaceOne(filter, doc, opts = {}) {
    const i = this.docs.findIndex((d) => matches(d, filter));
    if (i >= 0) this.docs[i] = { ...doc }; else if (opts.upsert) this.docs.push({ ...doc });
  }
  async estimatedDocumentCount() { return this.docs.length; }
  async drop() { this.docs = []; this.idx = new Map(); }
}
export class FakeDb {
  constructor() { this.cols = {}; this.databaseName = 'fake_swara'; }
  collection(n) { return (this.cols[n] ??= new Collection()); }
}
