#!/usr/bin/env node
// Boots Alpine and dumps profiler stats + opcode histograms at the login prompt.
import url from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");
const { V86 } = await import(root_path + "/build/libv86.mjs");
const { stats_to_string } = await import(root_path + "/src/browser/print_stats.js");

const ISO = process.env.ALPINE_ISO || root_path + "/images/alpine-virt-3.19.9-x86_64.iso";
const emulator = new V86({
    wasm_path: process.env.V86_WASM_PATH || root_path + "/build/v86.wasm",
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    cdrom: { url: ISO },
    memory_size: 512 * 1024 * 1024,
    autostart: true,
    log_level: 0,
});

const start = Date.now();
let output = "";
emulator.add_listener("serial0-output-byte", function(byte) {
    output += String.fromCharCode(byte);
    if(/login: $/.test(output))
    {
        console.log(`Login after ${((Date.now() - start) / 1000).toFixed(0)}s`);
        console.log(stats_to_string(emulator.v86.cpu));
        emulator.destroy();
        process.exit(0);
    }
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 600000);
