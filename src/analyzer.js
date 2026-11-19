// kevscope analyzer: streams QNX `traceprinter` text output line by line in constant memory.
// Works in Node (CLI) and the browser (File.stream()). No dependencies.
//
// Handles event lines such as:
//   t:0x0000a4c4 CPU:00 THREAD  :THRUNNING     pid:1 tid:1
//   t:0x0000a4c4 CPU:01 KER_CALL:MSG_SENDV/11 coid:0x40000001 ...
//   t:0x0000b100 CPU:01 KER_EXIT:MSG_SENDV/11 status:0x00000000
//   t:0x0000c000 CPU:00 INT_ENTR:0x00000040 (64)  IP:0xf000ef0c
//   t:0x0000c050 CPU:00 INT_EXIT:0x00000040 (64)  inkernel:0x00000f01
//   t:0x00001bd0 CPU:00 PROCESS :PROCCREATE_NAME   (followed by indented "pid:" / "name:" lines)
//   t:0x... CPU:00 THREAD :THCREATE pid:1 tid:4 ... ; name lines may follow ("name:worker")

const EV = /^t:0x([0-9a-fA-F]+)\s+CPU:(\d+)\s+([A-Z_]+)\s*:\s*([A-Z_0-9]+)(?:\/(\d+))?\s*(.*)$/;
const KV = /([a-zA-Z_]+):(\S+)/g;

const NB = 128, SUB = 4; // quarter-octave log buckets from ~1 ns to ~4 s (microseconds); constant memory
const idx = (us) => Math.min(NB - 1, Math.max(0, Math.ceil((Math.log2(Math.max(us, 0.001)) + 10) * SUB)));
class Hist {
  constructor(th = 100) { this.b = new Array(NB).fill(0); this.n = 0; this.sum = 0; this.max = 0; this.th = th; this.over = 0; }
  add(us) { this.n++; this.sum += us; if (us > this.max) this.max = us; if (us > this.th) this.over++; this.b[idx(us)]++; }
  pct(p) { if (!this.n) return 0; let k = Math.ceil(this.n * p), c = 0; for (let i = 0; i < NB; i++) { c += this.b[i]; if (c >= k) return Math.min(this.max, Math.pow(2, i / SUB - 10)); } return this.max; }
  json() { return { n: this.n, avg: this.n ? this.sum / this.n : 0, p50: this.pct(0.5), p99: this.pct(0.99), p999: this.pct(0.999), max: this.max, over: this.over, th: this.th, buckets: this.b }; }
}

export class Analyzer {
  constructor(opts = {}) {
    this.cps = opts.cyclesPerSec || 0; // set from header CYCLES_PER_SEC if present
    this.lines = 0; this.events = 0; this.t0 = null; this.t1 = 0; this.msb = 0;
    this.names = new Map(); // pid -> process name ; "pid/tid" -> thread name
    this.threads = new Map(); // key -> {run, ready:Hist, states:{}}
    this.cpu = new Map(); // cpu -> {cur, since, intStack:[]}
    this.readyAt = new Map(); // thread key -> t when became READY
    this.kcall = new Map(); // cpu -> {name, t, key}
    this.kstats = new Map(); // call -> Hist
    this.irq = new Map(); // vector -> Hist
    this.timeline = []; // sampled run segments [cpu, startUs, endUs, key]
    this.tlBudget = opts.timelineBudget || 6000;
    this.pending = null; // multi-line PROCCREATE_NAME/THCREATE context
    this.classCounts = {};
  }
  us(cyc) { return this.cps ? (cyc * 1e6) / this.cps : cyc / 1000; } // fallback: assume 1 GHz
  th(pid, tid) { const k = `${pid}/${tid}`; let t = this.threads.get(k); if (!t) { t = { run: 0, ready: new Hist(), states: {}, cpus: new Set(), blockers: {}, worstAt: 0 }; this.threads.set(k, t); } return [k, t]; }
  cpuState(c) { let s = this.cpu.get(c); if (!s) { s = { cur: null, since: 0, ints: [] }; this.cpu.set(c, s); } return s; }

  feed(line) {
    this.lines++;
    if (!this.cps) { const m = line.match(/CYCLES_PER_SEC::\s*(\d+)/); if (m) { this.cps = +m[1]; return; } }
    if (this.pending) {
      const m = line.match(/^\s+(pid|ppid|tid|name):\s*(.*)$/);
      if (m) { this.pending[m[1]] = m[2].trim(); return; }
      this.flushPending();
    }
    const m = line.match(EV);
    if (!m) return;
    this.events++;
    const cyc = parseInt(m[1], 16), c = +m[2], cls = m[3], ev = m[4], rest = m[6] || "";
    const t = this.us(cyc);
    if (this.t0 === null) this.t0 = t;
    if (t > this.t1) this.t1 = t;
    this.classCounts[cls] = (this.classCounts[cls] || 0) + 1;
    const kv = {}; for (const x of rest.matchAll(KV)) kv[x[1]] = x[2];

    if (cls === "PROCESS" && /PROCCREATE_NAME/.test(ev)) { this.pending = { kind: "proc", ...kv }; return; }
    if (cls === "THREAD") {
      if (ev === "THCREATE" || ev === "THNAME") { this.pending = { kind: "thread", ...kv }; }
      if (kv.pid == null || kv.tid == null) return;
      const [k, T] = this.th(kv.pid, kv.tid);
      const st = ev.replace(/^TH/, "");
      T.states[st] = (T.states[st] || 0) + 1;
      const cs = this.cpuState(c);
      if (ev === "THRUNNING") {
        const rk = this.readyAt.get(k); const prev = (cs.cur && !/idle/i.test(this.label(cs.cur))) ? cs.cur : (cs.lastBusy && rk != null && cs.lastBusy.end >= rk ? cs.lastBusy.key : null);
        if (cs.cur && cs.cur !== k) this.endRun(c, cs, t);
        if (cs.cur !== k) { cs.cur = k; cs.since = t; }
        T.cpus.add(c);
        const ra = this.readyAt.get(k);
        if (ra != null) {
          const w = t - ra; if (w > T.ready.max) T.worstAt = ra;
          T.ready.add(w); this.readyAt.delete(k);
          if (w > T.ready.th && prev && prev !== k && !/idle/i.test(this.label(prev))) { const b = (T.blockers[prev] = T.blockers[prev] || { n: 0, max: 0, cpu: c }); b.n++; if (w > b.max) b.max = w; }
        }
      } else {
        if (cs.cur === k) this.endRun(c, cs, t);
        if (ev === "THREADY") this.readyAt.set(k, t);
      }
      return;
    }
    if (cls === "KER_CALL") { const cs = this.cpuState(c); this.kcall.set(c, { name: ev, t, key: cs.cur }); return; }
    if (cls === "KER_EXIT") {
      const kc = this.kcall.get(c);
      if (kc && kc.name === ev) { let h = this.kstats.get(ev); if (!h) this.kstats.set(ev, (h = new Hist())); h.add(t - kc.t); this.kcall.delete(c); }
      return;
    }
    if (cls === "INT_ENTR") { this.cpuState(c).ints.push({ v: ev, t }); return; }
    if (cls === "INT_EXIT") {
      const cs = this.cpuState(c); const e = cs.ints.pop();
      if (e) { const vec = (rest.match(/\((\d+)\)/) || [])[1] || ev; let h = this.irq.get(vec); if (!h) this.irq.set(vec, (h = new Hist())); h.add(t - e.t); }
    }
  }
  flushPending() {
    const p = this.pending; this.pending = null;
    if (!p || !p.name) return;
    if (p.kind === "proc" && p.pid) this.names.set(p.pid, p.name);
    if (p.kind === "thread" && p.pid && p.tid) this.names.set(`${p.pid}/${p.tid}`, p.name);
  }
  endRun(c, cs, t) {
    const T = this.threads.get(cs.cur); if (T) T.run += t - cs.since;
    cs.last = { key: cs.cur, since: cs.since, end: t };
    if (cs.cur && !/idle/i.test(this.label(cs.cur))) cs.lastBusy = cs.last;
    this.segs = (this.segs || 0) + 1;
    if (this.timeline.length < this.tlBudget) this.timeline.push([c, cs.since, t, cs.cur]);
    else { const j = Math.floor(Math.random() * this.segs); if (j < this.tlBudget) this.timeline[j] = [c, cs.since, t, cs.cur]; }
    cs.cur = null;
  }
  label(k) {
    const [pid] = k.split("/");
    const pn = (this.names.get(pid) || `pid ${pid}`).split("/").pop();
    const tn = this.names.get(k);
    return tn ? `${pn} · ${tn}` : `${pn} · tid ${k.split("/")[1]}`;
  }
  result() {
    this.flushPending();
    for (const [c, cs] of this.cpu) if (cs.cur) this.endRun(c, cs, this.t1);
    const span = Math.max(1, this.t1 - (this.t0 || 0)), ncpu = this.cpu.size || 1;
    const threads = [...this.threads.entries()].map(([k, T]) => ({ key: k, label: this.label(k), runUs: T.run, cpuPct: (T.run / (span * ncpu)) * 100, ready: T.ready.json(), states: T.states, cpus: [...T.cpus], worstAt: T.worstAt - (this.t0 || 0), blockers: Object.entries(T.blockers).map(([b, v]) => ({ key: b, label: this.label(b), ...v })).sort((x, y) => y.n - x.n) }))
      .sort((a, b) => b.runUs - a.runUs);
    const idle = threads.filter((t) => /idle/i.test(t.label)).reduce((a, t) => a + t.runUs, 0);
    return {
      lines: this.lines, events: this.events, spanUs: span, cpus: ncpu, cyclesPerSec: this.cps || null,
      utilPct: 100 - (idle / (span * ncpu)) * 100,
      threads, classCounts: this.classCounts,
      kernel: [...this.kstats.entries()].map(([k, h]) => ({ call: k, ...h.json() })).sort((a, b) => b.n * b.avg - a.n * a.avg),
      irq: [...this.irq.entries()].map(([v, h]) => ({ vector: v, ...h.json() })).sort((a, b) => b.n - a.n),
      timeline: this.timeline.map(([c, s, e, k]) => [c, s - this.t0, e - this.t0, k]), t0: this.t0,
      labels: Object.fromEntries(threads.map((t) => [t.key, t.label])),
      worstReady: threads.filter((t) => t.ready.n).sort((a, b) => b.ready.max - a.ready.max).slice(0, 8),
    };
  }
}

export async function analyzeStream(readable, opts = {}, onProgress) {
  // readable: async iterable of string chunks
  const a = new Analyzer(opts); let buf = "", bytes = 0;
  for await (const chunk of readable) {
    bytes += chunk.length; buf += chunk;
    let i; while ((i = buf.indexOf("\n")) >= 0) { a.feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (onProgress) onProgress(bytes, a.events);
  }
  if (buf) a.feed(buf);
  return a.result();
}
