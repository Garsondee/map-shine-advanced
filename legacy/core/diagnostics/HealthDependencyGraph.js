/**
 * Small directed graph used by the health evaluator.
 * Edge type: required | contextual | optional
 */
export class HealthDependencyGraph {
  constructor() {
    /** @type {Map<string, Array<{to:string,type:string,meta?:object}>>} */
    this._edges = new Map();
  }

  addEdge(from, to, type = 'required', meta = null) {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f || !t) return false;
    const arr = this._edges.get(f) || [];
    arr.push({ to: t, type: String(type || 'required'), meta: meta || undefined });
    this._edges.set(f, arr);
    return true;
  }

  getOutgoing(from) {
    return this._edges.get(String(from || '').trim()) || [];
  }

  getAllEdges() {
    const out = [];
    for (const [from, list] of this._edges.entries()) {
      for (const edge of list) out.push({ from, ...edge });
    }
    return out;
  }

  clear() {
    this._edges.clear();
  }
}

