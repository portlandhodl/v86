#!/usr/bin/env node
// bench64 with set_jit_config knobs: node bench64-config.mjs 64 "7=0 8=0" [runs]
import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");
const { V86 } = await import(root_path + "/build/libv86.mjs");

const mode = process.argv[2] || "64";
const config = process.argv[3] || "";
const runs = +(process.argv[4] || 3);

const asm_file = path.join(__dirname, "bench64.asm");
const bin_file = path.join(__dirname, `bench${mode}.bin`);
execFileSync("nasm", ["-w+error", "-f", "bin", ...(mode === "64" ? ["-DMODE64"] : []), "-o", bin_file, asm_file]);

for (let r = 0; r < runs; r++) {
    await new Promise(resolve => {
        const emulator = new V86({
            wasm_path: root_path + "/build/v86.wasm",
            bios: { url: bin_file },
            autostart: true,
            memory_size: 64 * 1024 * 1024,
            log_level: 0,
        });
        if (config) {
            emulator.bus.register("emulator-started", () => {
                for (const kv of config.split(" ")) {
                    const [k, v] = kv.split("=");
                    emulator.v86.cpu.wm.exports["set_jit_config"](+k, +v);
                }
            });
        }
        let start;
        emulator.bus.register("emulator-started", () => { start = performance.now(); });
        emulator.add_listener("serial0-output-byte", byte => {
            if (byte !== 0x4B) return;
            const elapsed = performance.now() - start;
            const instructions = emulator.get_instruction_counter();
            console.log(`run ${r}: ${(instructions / elapsed / 1000).toFixed(1)} MIPS`);
            emulator.destroy();
            resolve();
        });
    });
}
