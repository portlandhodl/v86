#!/usr/bin/env node
// Boots Alpine to the login prompt with set_jit_config knobs from argv
// (e.g. "3=16,5=50000"); prints the boot time. For tuning sweeps.
import url from "node:url";
import path from "node:path";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");
const { V86 } = await import(root_path + "/build/libv86.mjs");
const emulator = new V86({
    wasm_path: root_path + "/build/v86.wasm",
    bios: { url: root_path + "/bios/seabios.bin" },
    vga_bios: { url: root_path + "/bios/vgabios.bin" },
    cdrom: { url: root_path + "/images/alpine-virt-3.19.9-x86_64.iso" },
    memory_size: 512 * 1024 * 1024,
    autostart: true,
    log_level: 0,
});
const cfg = Object.fromEntries((process.argv[2] || "").split(",").filter(s => s).map(s => s.split("=")).map(([a,b])=>[+a,+b]));
emulator.bus.register("emulator-started", () => {
    for(const [k, v] of Object.entries(cfg)) emulator.v86.cpu.wm.exports["set_jit_config"](k, v);
});
const start = Date.now();
let output = "";
emulator.add_listener("serial0-output-byte", function(byte) {
    output += String.fromCharCode(byte);
    if(/login: $/.test(output)) {
        console.log(`${((Date.now() - start) / 1000).toFixed(1)}s cfg=${process.argv[2] || "(defaults)"}`);
        emulator.destroy();
        process.exit(0);
    }
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 600000);
