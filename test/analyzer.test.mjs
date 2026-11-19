import { test } from "node:test";
import assert from "node:assert/strict";
import { Analyzer } from "../src/analyzer.js";
const L = (us, cpu, cls, ev, rest = "") => `t:0x${Math.round(us * 1000).toString(16).padStart(8, "0")} CPU:${String(cpu).padStart(2, "0")} ${cls.padEnd(8)}:${ev} ${rest}`;
test("run time, ready latency, kernel call and IRQ durations", () => {
  const a = new Analyzer({ cyclesPerSec: 1e9 });
  ["        CYCLES_PER_SEC:: 1000000000", L(0, 0, "PROCESS", "PROCCREATE_NAME"), "                       pid:7", "                      name:usr/bin/app",
   L(0, 0, "THREAD", "THRUNNING", "pid:1 tid:1"), L(100, 0, "THREAD", "THREADY", "pid:7 tid:2"), L(150, 0, "THREAD", "THRUNNING", "pid:7 tid:2"),
   L(160, 0, "KER_CALL", "MSG_SENDV/11", "coid:0x1"), L(190, 0, "KER_EXIT", "MSG_SENDV/11", "status:0x0"),
   L(200, 0, "INT_ENTR", "0x00000040", "(64) IP:0x1"), L(205, 0, "INT_EXIT", "0x00000040", "(64) inkernel:0x1"),
   L(350, 0, "THREAD", "THRECEIVE", "pid:7 tid:2"), L(350, 0, "THREAD", "THRUNNING", "pid:1 tid:1"), L(1000, 0, "THREAD", "THREADY", "pid:9 tid:1")].forEach((l) => a.feed(l));
  const r = a.result();
  const app = r.threads.find((t) => t.key === "7/2");
  assert.equal(Math.round(app.runUs), 200);
  assert.equal(Math.round(app.ready.max), 50);
  assert.match(app.label, /^app/);
  assert.equal(Math.round(r.kernel[0].max), 30);
  assert.equal(r.irq[0].vector, "64");
  assert.equal(Math.round(r.irq[0].max), 5);
});
test("constant memory: timeline capped", () => {
  const a = new Analyzer({ cyclesPerSec: 1e9, timelineBudget: 100 });
  for (let i = 0; i < 20000; i++) { a.feed(L(i * 10, 0, "THREAD", "THRUNNING", `pid:2 tid:${i % 2}`)); }
  assert.ok(a.result().timeline.length <= 100);
});
