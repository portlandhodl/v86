#!/usr/bin/env node

import url from "node:url";
import fs from "node:fs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

// MEMORY_MB: guest memory size, the test allocates and checks about 90% of it
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
};

const emulator = new V86(config);

emulator.bus.register("emulator-started", function()
{
    console.log("Booting now, please stand by");

    emulator.create_file("test.lua", Buffer.from(`
local t = {}
local m = 1
while collectgarbage("count") < ${MEMORY_MB * 0.88} * 1024 do
    t[m] = string.rep("A", 4096)
    m = m + 1
    if m % 10000 == 0 then
        print(m, " ", collectgarbage("count"))
    end
end
print("memory usage (kB) ", collectgarbage("count"))
print("page count ", m)
local ref = string.rep("A", 4096)
for i = 1, m - 1 do
    assert(t[i] == ref)
end
print("ok")
`));
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

        emulator.serial0_send("free -m\n");
        emulator.serial0_send("time -v lua /mnt/test.lua\n");
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
