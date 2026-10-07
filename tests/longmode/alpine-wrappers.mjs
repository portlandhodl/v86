#!/usr/bin/env node
// Boots Alpine with PROFILE_GENERIC=1 (set_jit_config 6) and dumps the
// per-wrapper execution counts (jit64_print_profile) at the login prompt.
import url from "node:url";
import path from "node:path";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");
const { V86 } = await import(root_path + "/build/libv86.mjs");

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

emulator.bus.register("emulator-started", () => {
    emulator.v86.cpu.wm.exports["set_jit_config"](6, 1);
});

const start = Date.now();
let output = "";
emulator.add_listener("serial0-output-byte", function(byte) {
    output += String.fromCharCode(byte);
    if(/login: $/.test(output))
    {
        console.log(`Login after ${((Date.now() - start) / 1000).toFixed(0)}s`);
        emulator.v86.cpu.wm.exports["jit64_print_profile"]();
        emulator.destroy();
        process.exit(0);
    }
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 600000);
