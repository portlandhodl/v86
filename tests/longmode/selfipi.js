#!/usr/bin/env node
// APIC self-IPI from compiled 64-bit code: the interrupt has to be delivered on
// an instruction boundary, not in the middle of the ICR write (see selfipi.asm).
// Same knobs as run.js: DISABLE_JIT, JIT64_CHAINING=0, V86_WASM_PATH, TEST_RELEASE_BUILD.

import url from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root_path = path.join(__dirname, "..", "..");

process.on("unhandledRejection", exn => { throw exn; });

const asm_file = path.join(__dirname, "selfipi.asm");
const bin_file = path.join(__dirname, "selfipi.bin");

try {
    execFileSync("nasm", ["-w+error", "-f", "bin", "-o", bin_file, asm_file]);
} catch(e) {
    console.log("nasm not available or failed, test skipped");
    process.exit(0);
}

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? root_path + "/build/libv86.mjs" : root_path + "/src/main.js");

const expected = [
    [20000n, "handled IPIs"],
    [0n, "rsp delta"],
    [0x1122334455667788n, "rbx"],
    [0x200n, "IF"],
    [0n, "timed out IPIs"],
    [0n, "IF lost after sending"],
];

const emulator = new V86({
    bios: { url: bin_file },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    wasm_path: process.env.V86_WASM_PATH,
});

if(process.env.JIT64_CHAINING === "0")
{
    emulator.bus.register("emulator-started", () => {
        emulator.v86.cpu.wm.exports["set_jit_config"](7, 0);
    });
}

const timeout = setTimeout(() => {
    const data = emulator.read_memory(0x9000, 8);
    console.log("[-] Timeout, handled IPIs: " + new BigUint64Array(data.buffer, data.byteOffset, 1)[0]);
    emulator.destroy();
    process.exit(1);
}, 60 * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    if(byte !== 0x4B) // 'K'
    {
        return;
    }
    clearTimeout(timeout);

    const data = emulator.read_memory(0x90000, expected.length * 8);
    const view = new BigUint64Array(data.buffer, data.byteOffset, expected.length);

    let failed = false;
    for(let i = 0; i < expected.length; i++)
    {
        if(view[i] !== expected[i][0])
        {
            console.log(`[-] ${expected[i][1]}: expected 0x${expected[i][0].toString(16)}, got 0x${view[i].toString(16)}`);
            failed = true;
        }
    }
    emulator.destroy();
    if(failed)
    {
        process.exit(1);
    }
    console.log("[+] selfipi test passed");
});
