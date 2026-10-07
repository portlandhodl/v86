#!/usr/bin/env node
// Like bench64.js but dumps profiler stats + opcode histograms after the run.
import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

const { V86 } = await import(root_path + "/src/main.js");
const { stats_to_string } = await import(root_path + "/src/browser/print_stats.js");

const asm_file = path.join(__dirname, "bench64.asm");
const mode = process.argv[2] || "64";

const bin_file = path.join(__dirname, `bench${mode}.bin`);
execFileSync("nasm", ["-w+error", "-f", "bin", ...(mode === "64" ? ["-DMODE64"] : []), "-o", bin_file, asm_file]);

const emulator = new V86({
    wasm_path: root_path + "/build/v86.wasm",
    bios: { url: bin_file },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
});
let start;
emulator.bus.register("emulator-started", () => { start = performance.now(); });
emulator.add_listener("serial0-output-byte", byte => {
    if(byte !== 0x4B) return;
    const elapsed = performance.now() - start;
    const instructions = emulator.get_instruction_counter();
    console.log(`${mode}-bit: ${elapsed.toFixed(0)} ms, ${(instructions / elapsed / 1000).toFixed(1)} MIPS`);
    console.log(stats_to_string(emulator.v86.cpu));
    emulator.destroy();
});
