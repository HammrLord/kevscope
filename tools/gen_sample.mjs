// Generates a SYNTHETIC trace in QNX traceprinter text format: a 2-CPU robot controller.
// Story: 1 kHz control loop normally scheduled in ~10 us, but a logger burst on CPU0 delays it.
import { writeFileSync } from "node:fs";
let seed = 7; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const CPS = 1_000_000_000, SEC = +(process.argv[3] || 2), out = [];
const hex = (us) => "0x" + Math.round(us * 1000).toString(16).padStart(8, "0");
const E = (us, cpu, cls, ev, rest = "") => out.push({ us, line: `t:${hex(us)} CPU:${String(cpu).padStart(2, "0")} ${cls.padEnd(8)}:${ev.padEnd(14)}${rest}` });
const P = [[1, "proc/boot/procnto-smp-instr"], [12, "proc/boot/devc-ser8250"], [30, "proc/boot/io-sock"], [2041, "usr/bin/robot_ctl"], [2077, "usr/bin/camera_srv"], [2100, "usr/bin/logger"]];
const head = ["TRACEPRINTER version 1.02", " -- HEADER FILE INFORMATION -- ", "       TRACE_FILE_NAME:: /tmp/robot.kev", "          TRACE_NODENAME:: qnx-qemu", `        TRACE_CPU_NUM:: 2`, `        CYCLES_PER_SEC:: ${CPS}`, " -- KERNEL EVENTS -- "];
const meta = [];
for (const [pid, name] of P) { meta.push(`t:${hex(0.1)} CPU:00 PROCESS :PROCCREATE_NAME`, `                      ppid:1`, `                       pid:${pid}`, `                      name:${name}`); }
const TH = [[1, 1, "idle-cpu0"], [1, 2, "idle-cpu1"], [2041, 1, "main"], [2041, 2, "ctl_loop"], [2041, 3, "planner"], [2077, 1, "frame_rx"], [2100, 1, "flush"], [30, 4, "rx"], [12, 2, "ser_rx"]];
for (const [pid, tid, name] of TH) meta.push(`t:${hex(0.2)} CPU:00 THREAD  :THCREATE      pid:${pid} tid:${tid}`, `                      name:${name}`);
const idle = (cpu) => [1, cpu + 1];
// state per cpu: running thread until; we build per-cpu schedule in time order
const sched = [[], []]; // segments {s,e,pid,tid}
const add = (cpu, s, e, pid, tid) => sched[cpu].push({ s, e, pid, tid });
// logger bursts on CPU0 every 200ms (2-3 ms), planner on CPU1 every 50ms (4 ms)
const busy = [[], []];
for (let t = 150_000; t < SEC * 1e6; t += 200_000) busy[0].push([t, t + 2000 + r() * 1200, 2100, 1]);
for (let t = 20_000; t < SEC * 1e6; t += 50_000) busy[1].push([t, t + 3500 + r() * 1500, 2041, 3]);
const inBusy = (cpu, t) => busy[cpu].find(([s, e]) => t >= s && t < e);
// control loop on CPU0 at 1 kHz
let ctlLate = 0;
for (let k = 1; k < SEC * 1000; k++) {
  const wake = k * 1000; const b = inBusy(0, wake);
  const lat = b ? b[1] - wake + 0.6 : 4 + r() * 12; // blocked behind logger (same priority, FIFO)
  if (b) ctlLate++;
  E(wake, 0, "THREAD", "THREADY", ` pid:2041 tid:2`);
  const s = wake + lat, runEnd = s + 90 + r() * 60;
  add(0, s, runEnd, 2041, 2);
  E(s + 20, 0, "KER_CALL", "MSG_SENDV/11", ` coid:0x40000004 msg:"pose"`);
  E(s + 20 + 18 + r() * 40, 0, "KER_EXIT", "MSG_SENDV/11", ` status:0x00000000`);
}
for (const cpu of [0, 1]) for (const [s, e, pid, tid] of busy[cpu]) add(cpu, s, e, pid, tid);
// camera frames: IRQ 64 at 30 Hz on CPU1 then frame_rx runs 400 us
for (let t = 10_000; t < SEC * 1e6; t += 33_333) { const d = 5 + r() * 6; E(t, 1, "INT_ENTR", "0x00000040", ` (64)       IP:0xf000ef0c`); E(t + d, 1, "INT_EXIT", "0x00000040", ` (64) inkernel:0x00000f01`); E(t + d + 1, 1, "THREAD", "THREADY", ` pid:2077 tid:1`); if (!inBusy(1, t)) add(1, t + d + 8, t + d + 420, 2077, 1); }
// network IRQ 72 ~ every 2 ms on CPU1
for (let t = 500; t < SEC * 1e6; t += 1500 + r() * 1000) { const d = 2 + r() * 4; E(t, 1, "INT_ENTR", "0x00000048", ` (72)       IP:0xf001a210`); E(t + d, 1, "INT_EXIT", "0x00000048", ` (72) inkernel:0x00000f01`); }
// timer IRQ 0 every 1 ms both CPUs
for (let t = 1000; t < SEC * 1e6; t += 1000) for (const c of [0, 1]) { const d = 1 + r() * 1.5; E(t - 0.5, c, "INT_ENTR", "0x00000000", ` (0)        IP:0xf000a000`); E(t - 0.5 + d, c, "INT_EXIT", "0x00000000", ` (0) inkernel:0x00000f01`); }
// emit THRUNNING / state changes, filling gaps with idle
for (const cpu of [0, 1]) {
  const segs = sched[cpu].sort((a, b) => a.s - b.s); let t = 0;
  const [ip, it] = idle(cpu);
  for (const g of segs) {
    if (g.s < t) g.s = t + 0.5;
    if (g.s - t < 1.5 && g.s > t) g.s = t; // back-to-back switch: no idle slice
    if (g.e <= g.s) continue;
    if (g.s > t) E(t, cpu, "THREAD", "THRUNNING", `     pid:${ip} tid:${it}`);
    E(g.s, cpu, "THREAD", "THRUNNING", `     pid:${g.pid} tid:${g.tid}`);
    E(g.e, cpu, "THREAD", g.pid === 2041 && g.tid === 2 ? "THNANOSLEEP" : "THRECEIVE", `   pid:${g.pid} tid:${g.tid}`);
    t = g.e;
  }
  E(t, cpu, "THREAD", "THRUNNING", `     pid:${ip} tid:${it}`);
}
out.sort((a, b) => a.us - b.us);
writeFileSync(process.argv[2] || "sample/robot_trace.txt", [...head, ...meta, ...out.map((o) => o.line)].join("\n") + "\n");
console.log(`wrote ${out.length} events; control-loop wakeups delayed by logger: ${ctlLate}`);
