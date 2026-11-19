#!/usr/bin/env node
// kevscope CLI: stream a traceprinter text file (any size) and write a self-contained HTML report.
// usage: traceprinter -f trace.kev | kevscope - -o report.html     or     kevscope trace.txt -o report.html [--json]
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { analyzeStream } from "../src/analyzer.js";
const args = process.argv.slice(2);
if (!args.length || args.includes("-h")) { console.log("usage: kevscope <trace.txt|-> [-o report.html] [--json]"); process.exit(0); }
const input = args[0], out = args[args.indexOf("-o") + 1] && args.includes("-o") ? args[args.indexOf("-o") + 1] : "kevscope-report.html";
const src = input === "-" ? process.stdin.setEncoding("utf8") : createReadStream(input, { encoding: "utf8", highWaterMark: 1 << 20 });
const t0 = Date.now();
const r = await analyzeStream(src, {}, (bytes, ev) => { if (process.stderr.isTTY) process.stderr.write(`\r${(bytes / 1e6).toFixed(1)} MB · ${ev.toLocaleString()} events`); });
process.stderr.write(`\nanalysed ${r.events.toLocaleString()} events in ${((Date.now() - t0) / 1000).toFixed(2)} s · heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB\n`);
if (args.includes("--json")) { writeFileSync(out.replace(/\.html$/, ".json"), JSON.stringify(r)); }
const here = new URL("../web/", import.meta.url);
const tpl = readFileSync(new URL("report.html", here), "utf8").replace("<!--CSS-->", readFileSync(new URL("report.css", here), "utf8")), js = readFileSync(new URL("report.js", here), "utf8").replace(/^export /gm, "");
writeFileSync(out, tpl.replace("<!--DATA-->", `<script>window.KEVSCOPE_DATA=${JSON.stringify(r)}</script><script type="module">${js}</script>`));
console.log("report:", out);
