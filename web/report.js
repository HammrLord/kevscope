// kevscope report renderer (browser). render(root, data) — data = Analyzer.result()
const h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fus = (us) => us >= 1e6 ? (us / 1e6).toFixed(2) + " s" : us >= 1000 ? (us / 1000).toFixed(2) + " ms" : us.toFixed(1) + " µs";
const hue = (k) => [...k].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const PAL = ["#22D3EE", "#F59E0B", "#F43F5E", "#A78BFA", "#22C55E", "#FB923C", "#38BDF8", "#E879F9", "#FACC15", "#2DD4BF"];
let PALMAP = {};
const colorOf = (k, label) => /idle/i.test(label) ? "#273244" : PALMAP[k] || `hsl(${hue(k)} 70% 55%)`;

function findings(d) {
  const out = [];
  for (const t of d.threads) if (t.ready.over) {
    const b = t.blockers[0];
    out.push({ sev: "high", title: `${t.label} missed ${t.ready.over} scheduling deadline${t.ready.over > 1 ? "s" : ""} (> ${t.ready.th} µs)`, body: `Worst wait ${fus(t.ready.max)} at t = ${fus(t.worstAt)}; typical ${fus(t.ready.p50)}.${b ? ` Most often the CPU was held by <b>${h(b.label)}</b> (${b.n}×, up to ${fus(b.max)}) on CPU${b.cpu}. Consider raising ${h(t.label.split(" · ").pop())}'s priority, moving the blocker to another CPU (runmask), or splitting its work.` : ""}` });
  }
  const irqWorst = d.irq.slice().sort((a, b) => b.max - a.max)[0];
  if (irqWorst) out.push({ sev: irqWorst.max > 50 ? "high" : "info", title: `Longest interrupt handler: vector ${irqWorst.vector} at ${fus(irqWorst.max)}`, body: `${irqWorst.n.toLocaleString()} interrupts, median ${fus(irqWorst.p50)}. Keep ISRs short; defer work to an event-driven thread (InterruptAttachEvent).` });
  const kc = d.kernel[0];
  if (kc) out.push({ sev: "info", title: `Heaviest kernel call: ${kc.call}`, body: `${kc.n.toLocaleString()} calls, avg ${fus(kc.avg)}, max ${fus(kc.max)}. For MsgSend this is the full IPC round trip to the server.` });
  out.push({ sev: "info", title: `System utilisation ${d.utilPct.toFixed(1)}% across ${d.cpus} CPU${d.cpus > 1 ? "s" : ""}`, body: `${d.events.toLocaleString()} events over ${fus(d.spanUs)} streamed in constant memory.` });
  return out;
}

export function render(root, d) {
  const busiest = d.threads.filter((t) => !/idle/i.test(t.label));
  PALMAP = {}; busiest.forEach((t, i) => (PALMAP[t.key] = PAL[i % PAL.length]));
  const worst = d.worstReady[0];
  const misses = d.threads.reduce((a, t) => a + t.ready.over, 0);
  root.innerHTML = `
  <section class="kpis">
    <div><b>${fus(d.spanUs)}</b><span>trace span</span></div>
    <div><b>${d.events.toLocaleString()}</b><span>events</span></div>
    <div><b>${d.cpus}</b><span>CPUs</span></div>
    <div><b>${d.utilPct.toFixed(1)}%</b><span>utilisation</span></div>
    <div class="${misses ? "bad" : ""}"><b>${misses}</b><span>deadline misses</span></div>
    <div class="${worst && worst.ready.max > 100 ? "bad" : ""}"><b>${worst ? fus(worst.ready.max) : "—"}</b><span>worst sched latency</span></div>
  </section>
  <section class="card"><h3>Findings</h3><div class="finds">${findings(d).map((f) => `<div class="find ${f.sev}"><b>${f.title}</b><p>${f.body}</p></div>`).join("")}</div></section>
  <section class="card"><div class="row"><h3>CPU timeline</h3><span class="hint">scroll to zoom · drag to pan · hover for details</span></div><canvas id="tl" height="${70 + d.cpus * 46}"></canvas><div id="tip" class="tip" hidden></div><div class="legend" id="legend"></div></section>
  <section class="grid2">
    <div class="card"><h3>Threads</h3><table class="tbl" id="tt"><thead><tr><th data-k="label">Thread</th><th data-k="cpuPct">CPU %</th><th data-k="p50">Ready p50</th><th data-k="p999">p99.9</th><th data-k="max">Max</th><th data-k="over">Misses</th></tr></thead><tbody></tbody></table></div>
    <div class="card"><h3 id="hh">Scheduling latency</h3><canvas id="hist" height="220"></canvas><p class="hint" id="hsub"></p></div>
  </section>
  <section class="grid2">
    <div class="card"><h3>Interrupts</h3><table class="tbl"><thead><tr><th>Vector</th><th>Count</th><th>Median</th><th>p99</th><th>Max</th></tr></thead><tbody>${d.irq.map((i) => `<tr><td>${h(i.vector)}</td><td>${i.n.toLocaleString()}</td><td>${fus(i.p50)}</td><td>${fus(i.p99)}</td><td>${fus(i.max)}</td></tr>`).join("")}</tbody></table></div>
    <div class="card"><h3>Kernel calls</h3><table class="tbl"><thead><tr><th>Call</th><th>Count</th><th>Avg</th><th>p99</th><th>Max</th></tr></thead><tbody>${d.kernel.map((k) => `<tr><td>${h(k.call)}</td><td>${k.n.toLocaleString()}</td><td>${fus(k.avg)}</td><td>${fus(k.p99)}</td><td>${fus(k.max)}</td></tr>`).join("") || `<tr><td colspan=5>No kernel-call events in this trace</td></tr>`}</tbody></table></div>
  </section>`;

  // threads table
  let sortK = "cpuPct", dir = -1, sel = (worst || busiest[0] || d.threads[0])?.key;
  const val = (t, k) => k === "label" ? t.label : k === "cpuPct" ? t.cpuPct : k === "over" ? t.ready.over : t.ready[k];
  const drawTable = () => {
    const rows = d.threads.slice().sort((a, b) => { const x = val(a, sortK), y = val(b, sortK); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    root.querySelector("#tt tbody").innerHTML = rows.map((t) => `<tr data-key="${h(t.key)}" class="${t.key === sel ? "sel" : ""} ${t.ready.over ? "warn" : ""}"><td><i style="background:${colorOf(t.key, t.label)}"></i>${h(t.label)}</td><td>${t.cpuPct.toFixed(2)}</td><td>${t.ready.n ? fus(t.ready.p50) : "—"}</td><td>${t.ready.n ? fus(t.ready.p999) : "—"}</td><td>${t.ready.n ? fus(t.ready.max) : "—"}</td><td>${t.ready.over || ""}</td></tr>`).join("");
    root.querySelectorAll("#tt tbody tr").forEach((tr) => (tr.onclick = () => { sel = tr.dataset.key; drawTable(); drawHist(); }));
  };
  root.querySelectorAll("#tt th").forEach((th) => (th.onclick = () => { dir = sortK === th.dataset.k ? -dir : -1; sortK = th.dataset.k; drawTable(); }));

  // histogram
  const drawHist = () => {
    const t = d.threads.find((x) => x.key === sel); const cv = root.querySelector("#hist"); const W = (cv.width = cv.clientWidth * devicePixelRatio), H = (cv.height = 220 * devicePixelRatio); const g = cv.getContext("2d");
    g.clearRect(0, 0, W, H); root.querySelector("#hh").textContent = `Scheduling latency · ${t ? t.label : ""}`;
    if (!t || !t.ready.n) { root.querySelector("#hsub").textContent = "No READY→RUNNING transitions for this thread."; return; }
    const b = t.ready.buckets; let lo = b.findIndex((x) => x > 0), hi = b.length - 1 - [...b].reverse().findIndex((x) => x > 0); lo = Math.max(0, lo - 2); hi = Math.min(b.length - 1, hi + 2);
    const n = hi - lo + 1, bw = (W - 40 * devicePixelRatio) / n, mx = Math.max(...b.slice(lo, hi + 1)); const base = H - 30 * devicePixelRatio;
    g.font = `${11 * devicePixelRatio}px Inter, sans-serif`; g.fillStyle = "#8B98AD";
    for (let i = 0; i < n; i++) { const v = b[lo + i]; if (!v) continue; const us = Math.pow(2, (lo + i) / 4 - 10); const bh = (Math.log10(v + 1) / Math.log10(mx + 1)) * (base - 20 * devicePixelRatio);
      g.fillStyle = us > t.ready.th ? "#F43F5E" : "#22D3EE"; g.fillRect(30 * devicePixelRatio + i * bw, base - bh, Math.max(1, bw - 2), bh); }
    g.fillStyle = "#8B98AD"; for (let i = 0; i < n; i += Math.ceil(n / 6)) g.fillText(fus(Math.pow(2, (lo + i) / 4 - 10)), 30 * devicePixelRatio + i * bw, H - 10 * devicePixelRatio);
    root.querySelector("#hsub").innerHTML = `${t.ready.n.toLocaleString()} wake-ups · p50 ${fus(t.ready.p50)} · p99 ${fus(t.ready.p99)} · max ${fus(t.ready.max)} · <span style="color:#F43F5E">${t.ready.over} over ${t.ready.th} µs</span> (log-scale counts)`;
  };

  // timeline
  const cv = root.querySelector("#tl"), tip = root.querySelector("#tip");
  let v0 = 0, v1 = d.spanUs; const zoomTo = (a, b) => { v0 = Math.max(0, a); v1 = Math.min(d.spanUs, Math.max(a + 5, b)); drawTL(); };
  if (worst && worst.ready.max > 100) { v0 = Math.max(0, worst.worstAt - 4000); v1 = Math.min(d.spanUs, worst.worstAt + 6000); }
  const segs = d.timeline.slice().sort((a, b) => a[1] - b[1]);
  const drawTL = () => {
    const dpr = devicePixelRatio, W = (cv.width = cv.clientWidth * dpr), H = (cv.height = (70 + d.cpus * 46) * dpr), g = cv.getContext("2d"), L = 70 * dpr;
    g.fillStyle = "#0E141F"; g.fillRect(0, 0, W, H); g.font = `${12 * dpr}px Inter, sans-serif`;
    const X = (us) => L + ((us - v0) / (v1 - v0)) * (W - L - 10 * dpr);
    for (let c = 0; c < d.cpus; c++) { g.fillStyle = "#8B98AD"; g.fillText(`CPU${c}`, 12 * dpr, (40 + c * 46 + 20) * dpr); g.fillStyle = "#161E2C"; g.fillRect(L, (40 + c * 46) * dpr, W - L - 10 * dpr, 34 * dpr); }
    for (const [c, s, e, k] of segs) { if (e < v0 || s > v1) continue; const x0 = X(Math.max(s, v0)), x1 = X(Math.min(e, v1)); g.fillStyle = colorOf(k, d.labels[k] || ""); g.fillRect(x0, (40 + c * 46) * dpr, Math.max(1, x1 - x0), 34 * dpr); }
    if (worst && worst.worstAt >= v0 && worst.worstAt <= v1) { const xa = X(worst.worstAt), xb = X(worst.worstAt + worst.ready.max); g.strokeStyle = "#F43F5E"; g.lineWidth = 2 * dpr; g.strokeRect(xa, 34 * dpr, Math.max(3, xb - xa), (d.cpus * 46 + 6) * dpr); g.fillStyle = "#F43F5E"; g.fillText(`worst wait ${fus(worst.ready.max)}`, Math.min(xa, W - 160 * dpr), 26 * dpr); }
    g.fillStyle = "#8B98AD"; const sp = v1 - v0, ax = (us) => sp < 50000 ? (us / 1000).toFixed(sp < 5000 ? 2 : 1) + " ms" : fus(us); for (let i = 0; i <= 5; i++) { const us = v0 + (sp * i) / 5; g.fillText(ax(us), Math.min(X(us) - 20 * dpr, W - 70 * dpr), H - 8 * dpr); }
  };
  cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(), f = (e.clientX - r.left - 70) / (r.width - 80), at = v0 + f * (v1 - v0), z = e.deltaY > 0 ? 1.25 : 0.8; zoomTo(at - (at - v0) * z, at + (v1 - at) * z); }, { passive: false });
  let drag = null; cv.onmousedown = (e) => (drag = { x: e.clientX, v0, v1 }); window.addEventListener("mouseup", () => (drag = null));
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect();
    if (drag) { const dx = ((e.clientX - drag.x) / (r.width - 80)) * (drag.v1 - drag.v0); zoomTo(drag.v0 - dx, drag.v1 - dx); return; }
    const us = v0 + ((e.clientX - r.left - 70) / (r.width - 80)) * (v1 - v0), c = Math.floor((e.clientY - r.top - 40) / 46);
    const s = segs.find((x) => x[0] === c && x[1] <= us && x[2] >= us);
    if (s) { tip.hidden = false; tip.style.left = e.clientX - r.left + 14 + "px"; tip.style.top = e.clientY - r.top + 10 + "px"; tip.innerHTML = `<b>${h(d.labels[s[3]] || s[3])}</b><br>CPU${s[0]} · ${fus(s[2] - s[1])} at ${fus(s[1])}`; } else tip.hidden = true;
  };
  cv.onmouseleave = () => (tip.hidden = true);
  root.querySelector("#legend").innerHTML = busiest.slice(0, 8).map((t) => `<span><i style="background:${colorOf(t.key, t.label)}"></i>${h(t.label)}</span>`).join("") + `<span><i style="background:#273244"></i>idle</span>`;
  drawTable(); drawHist(); drawTL(); addEventListener("resize", () => { drawTL(); drawHist(); });
  return { zoomTo, select: (k) => { sel = k; drawTable(); drawHist(); } };
}
if (typeof window !== "undefined" && window.KEVSCOPE_DATA) { const el = document.getElementById("report"); if (el) render(el, window.KEVSCOPE_DATA); }
