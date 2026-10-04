#!/usr/bin/env node

import url from "node:url";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

// MEMORY_MB: guest memory size, the test allocates and checks about 88% of it.
// The payload is the freestanding (no_std) 32-bit memhog binary (memhog.rs,
// rebuilt with `make tests/api/memhog`): it grows the heap with brk, fills
// every word with a per-page pattern and re-verifies it. It replaced the Lua
// payload, which goes quadratic in the GC at ~2 GiB of managed memory — a
// limitation of 32-bit Lua, not of the emulator.
const MEMORY_MB = +process.env.MEMORY_MB || 2048;

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    network_relay_url: "<UNUSED>",
    autostart: true,
    memory_size: MEMORY_MB * 1024 * 1024,
    filesystem: {},
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
    // V86_WASM_PATH overrides the core build, e.g. build/v86-mem64-debug.wasm
    wasm_path: process.env.V86_WASM_PATH,
};

const emulator = new V86(config);

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");
    emulator.create_file("memhog", fs.readFileSync(__dirname + "/memhog"));
});

let ran_command = false;
let line = "";
let passed = false;

emulator.add_listener("serial0-output-byte", async function(byte)
{
    const chr = String.fromCharCode(byte);

    if(chr < " " && chr !== "\n" && chr !== "\t" || chr > "~")
    {
        return;
    }

    if(chr === "\n")
    {
        var new_line = line;
        console.error("Serial: %s", line);
        line = "";
    }
    else if(chr >= " " && chr <= "~")
    {
        line += chr;
    }

    if(!ran_command && line.endsWith("~% "))
    {
        ran_command = true;

        const target = Math.floor(MEMORY_MB * 0.88);
        // copy out of the 9p mount (its files aren't executable)
        emulator.serial0_send("free -m\n");
        emulator.serial0_send("cat /mnt/memhog > /root/memhog && chmod +x /root/memhog\n");
        emulator.serial0_send("time -v /root/memhog " + target + "\n");
        emulator.serial0_send("echo test fini''shed\n");
    }

    if(chr === "\n" && new_line === "ok")
    {
        passed = true;
    }

    if(chr === "\n" && new_line.startsWith("test finished"))
    {
        emulator.destroy();
        if(passed)
        {
            console.log("[+] Test passed");
        }
        else
        {
            console.log("[!] Test failed");
            process.exit(1);
        }
    }
});
