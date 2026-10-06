#!/usr/bin/env node

// Instruction set fuzzer.
//
// Enumerates every implemented instruction from gen/x86_table.js and, for
// each one, generates random test cases (tests/fuzz/gen_case.js): random
// operand encodings (modrm/sib/displacement/immediates) on top of a random
// initial machine state (GPRs, eflags, x87/MMX, XMM, scratch memory), in both
// 32-bit protected mode and 64-bit long mode.
//
// Every case is executed twice in the same emulator instance:
//   1. with the JIT disabled (pure interpreter)
//   2. with the block force-compiled by the JIT (jit64 for 64-bit cases)
// and the resulting CPU state (all 16 GPRs, eflags, FPU/MMX/XMM state,
// scratch memory, raised exception) is compared. Any divergence is a bug in
// the interpreter or the code generator. Emulator crashes (wasm panics) are
// reported per-case and the campaign continues with a fresh instance.
//
// Environment variables:
//   FUZZ_SEED=n        Base seed (default: 1). Cases are derived
//                      deterministically, so a failure is reproduced by
//                      re-running with the same FUZZ_SEED and TEST_NAME.
//   FUZZ_CASES=n       Number of random cases per instruction/config
//                      (default: 10)
//   FUZZ_MAX_CASES=n   Stop after n cases total (default: unlimited)
//   MAX_PARALLEL_TESTS=n  Number of worker processes (default: number of
//                      cpus). Sharding is by case index, so results are
//                      identical for any worker count.
//   TEST_NAME=regex    Only fuzz instructions whose generated name matches
//   TEST_RELEASE_BUILD=1  Test the release build. Note: the JIT side of the
//                      comparison requires the debug build (force compilation
//                      is not available in release), so this only checks that
//                      the interpreter doesn't crash.
//   V86_WASM_PATH=...  Override the wasm build (e.g. build/v86-mem64-debug.wasm)

import url from "node:url";
import process from "node:process";
import os from "node:os";
import cluster from "node:cluster";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const gen = await import("./gen_case.js");
const table = (await import("../../gen/x86_table.js")).default;

const FUZZ_SEED = (process.env.FUZZ_SEED === undefined ? 1 : +process.env.FUZZ_SEED) >>> 0;
const FUZZ_CASES = +process.env.FUZZ_CASES || 10;
const FUZZ_MAX_CASES = +process.env.FUZZ_MAX_CASES || Infinity;
const TEST_NAME = new RegExp(process.env.TEST_NAME || "", "i");
const SINGLE_CASE_TIMEOUT = 10000;

// worker sharding (set by the primary process; don't set manually)
const WORKER_INDEX = +(process.env.FUZZ_WORKER_INDEX || 0);
const WORKER_TOTAL = +(process.env.FUZZ_WORKER_TOTAL || 1);
const IS_WORKER = process.env.FUZZ_WORKER_INDEX !== undefined;

const MASK_ARITH = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11;
const FPU_STATUS_MASK = 0xFFFF & ~(1 << 9 | 1 << 5 | 1 << 3 | 1 << 1); // as in tests/nasm/run.js

const GPR_NAMES = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
for(let i = 8; i < 16; i++) GPR_NAMES.push("r" + i);

function h(x, l)
{
    x = (x >>> 0).toString(16).toUpperCase();
    while(x.length < l) x = "0" + x;
    return x;
}

function hex_bytes(bytes)
{
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(" ");
}

function format_value(v)
{
    if(typeof v === "number")
    {
        return "0x" + (v >>> 0).toString(16);
    }
    return String(v);
}

// ---------------------------------------------------------------------------
// emulator setup
// ---------------------------------------------------------------------------

let emulator = null;

// The currently executing run_until_halt() call, dispatched from the global
// listeners below.
let active = null;

function create_emulator()
{
    const emulator = new V86({
        autostart: false,
        memory_size: 2 * 1024 * 1024,
        log_level: +process.env.LOG_LEVEL || 0,
        wasm_path: process.env.V86_WASM_PATH,
    });

    emulator.bus.register("cpu-event-halt", function()
    {
        if(active)
        {
            active.on_halt();
        }
    });

    emulator.cpu_exception_hook = function(n)
    {
        if(!active)
        {
            return true;
        }
        return active.on_exception(n);
    };

    return emulator;
}

function emulator_loaded(emulator)
{
    return new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
}

// A wasm panic (or any other hard error) inside a guest tick kills the
// emulator's scheduling loop. Recover: abort the in-flight case (it counts
// as a crash failure), discard the emulator and let main() create a fresh
// one so the fuzz campaign continues.
function handle_uncaught(error)
{
    if(active && active.on_crash)
    {
        active.on_crash(error);
    }
    else
    {
        // outside of a case: harness bug, die with the error
        throw error;
    }
}
process.on("uncaughtException", handle_uncaught);
process.on("unhandledRejection", handle_uncaught);

function capture_state(cpu, exception, low_mem_compare)
{
    return {
        // r0-r15, lo/hi 32-bit halves interleaved
        regs: Array.from(cpu.reg32s),
        eflags: cpu.get_eflags() & MASK_ARITH,
        xmm: Array.from(cpu.reg_xmm32s),
        xmm_high: Array.from(cpu.reg_xmm32s_high),
        // physical fpu register stack (holds mmx state when mmx is in use)
        fpu_st: Array.from(cpu.fpu_st),
        fpu_tag: cpu.fpu_load_tag_word(),
        fpu_status: cpu.fpu_load_status_word() & FPU_STATUS_MASK,
        mem: Array.from(new Int32Array(
            cpu.mem8.buffer,
            cpu.mem8.byteOffset + gen.SCRATCH_ADDR,
            gen.SCRATCH_SIZE >> 2)),
        // 16-bit addressing forms can reach (and wrap within) the first 64 KiB
        low_mem: low_mem_compare ? Array.from(new Int32Array(
            cpu.mem8.buffer,
            cpu.mem8.byteOffset,
            gen.LOWMEM_SIZE >> 2)) : null,
        exception,
    };
}

// identity maps of low memory for the paging cases
function setup_long_mode_paging(cpu)
{
    // PAE: PML4 -> PDPT -> PD (2 MiB page)
    const m32 = cpu.mem32s;
    m32[gen.PML4_ADDR >> 2] = gen.PDPT_ADDR | 3; // P|RW
    m32[gen.PDPT_ADDR >> 2] = gen.PD_ADDR | 3;
    m32[gen.PD_ADDR >> 2] = 0x83; // P|RW|PS
}

function setup_32bit_paging(cpu)
{
    // classic 2-level paging: PD with one 4 MiB page
    cpu.mem32s[gen.PD32_ADDR >> 2] = 0x83; // P|RW|PS
}

// Runs the emulator until the next hlt (or CPU exception, which is turned
// into a hlt). Returns the recorded exception, if any.
function run_until_halt(recorded)
{
    return new Promise((resolve, reject) =>
    {
        const cpu = emulator.v86.cpu;

        const finish = error =>
        {
            clearTimeout(timeout);
            active = null;
            if(error)
            {
                reject(error);
            }
            else
            {
                // not awaited: the next run re-runs the emulator, which
                // invalidates the pending tick; awaiting "emulator-stopped"
                // would cost a 100ms idle tick per case
                emulator.stop();
                resolve();
            }
        };

        const timeout = setTimeout(() =>
        {
            finish(new Error("case timed out"));
        }, SINGLE_CASE_TIMEOUT);

        active = {
            on_crash(error)
            {
                finish(error instanceof Error ? error : new Error(String(error)));
            },
            on_exception(n)
            {
                if(recorded.exception)
                {
                    // already recorded the fault that ends this case; swallow
                    // any follow-up exceptions
                    cpu.instruction_counter[0] += 100000;
                    return true;
                }

                const eip = cpu.instruction_pointer[0];
                recorded.exception = { vector: n, eip };

                // replace the faulting instruction with hlt so execution
                // stops (same technique as tests/nasm/run.js)
                cpu.instruction_counter[0] += 100000; // always make progress
                cpu.write32(cpu.translate_address_system_read(eip), 0xF4F4F4F4);
                return true;
            },
            on_halt()
            {
                finish(null);
            },
        };

        emulator.run();
    });
}

function force_generate_and_run(entry)
{
    const cpu = emulator.v86.cpu;
    return new Promise((resolve, reject) =>
    {
        cpu.test_hook_did_finalize_wasm = function()
        {
            cpu.test_hook_did_finalize_wasm = null;
            // don't synchronously call into the emulator from this callback
            setTimeout(() => resolve(), 0);
        };
        try
        {
            cpu.jit_force_generate(entry);
        }
        catch(e)
        {
            reject(e);
        }
    });
}

async function run_variant(test_case, use_jit)
{
    const cpu = emulator.v86.cpu;

    cpu.reboot_internal();
    cpu.reset_memory();
    cpu.load_multiboot(test_case.image.buffer);
    if(test_case.mode === 64)
    {
        setup_long_mode_paging(cpu);
    }
    else if(test_case.paging)
    {
        setup_32bit_paging(cpu);
    }
    cpu.mem8.set(test_case.scratch, gen.SCRATCH_ADDR);

    cpu.set_jit_config(0, use_jit ? 0 : 1); // JIT enabled/disabled

    const recorded = { exception: null };

    if(test_case.mode === 64)
    {
        // phase 1: run the 32-bit mode-switch stub (interpreted in both
        // variants; it's fixed code covered by the longmode tests), which
        // halts at the start of the 64-bit body
        await run_until_halt(recorded);
        if(recorded.exception)
        {
            return capture_state(cpu, recorded.exception, test_case.low_mem_compare);
        }

        // resume after the hlt, in 64-bit mode
        cpu.in_hlt[0] = 0;
        const entry64 = cpu.instruction_pointer[0];

        if(use_jit)
        {
            await force_generate_and_run(entry64);
        }
        await run_until_halt(recorded);
        return capture_state(cpu, recorded.exception, test_case.low_mem_compare);
    }

    if(use_jit)
    {
        await force_generate_and_run(cpu.instruction_pointer[0]);
    }
    await run_until_halt(recorded);
    return capture_state(cpu, recorded.exception, test_case.low_mem_compare);
}

// ---------------------------------------------------------------------------
// state comparison
// ---------------------------------------------------------------------------

function compare_states(name, a, b)
{
    const failures = [];
    const check = (what, x, y) =>
    {
        if(!Object.is(x, y))
        {
            failures.push({ name: what, interp: x, jit: y });
        }
    };

    check("exception vector", a.exception && a.exception.vector, b.exception && b.exception.vector);
    check("exception eip", a.exception && a.exception.eip, b.exception && b.exception.eip);

    if(a.exception && b.exception &&
        (a.exception.vector !== b.exception.vector || a.exception.eip !== b.exception.eip))
    {
        // different control flow; register comparison is not meaningful
        return failures;
    }

    for(let i = 0; i < 16; i++)
    {
        check("cpu.reg " + GPR_NAMES[i] + " lo", a.regs[i << 1], b.regs[i << 1]);
        check("cpu.reg " + GPR_NAMES[i] + " hi", a.regs[(i << 1) + 1], b.regs[(i << 1) + 1]);
    }
    check("eflags", a.eflags, b.eflags);

    for(let i = 0; i < 32; i++)
    {
        check("xmm" + (i >> 2) + ".int32[" + (i & 3) + "]", a.xmm[i], b.xmm[i]);
    }
    for(let i = 0; i < 32; i++)
    {
        check("xmm" + (8 + (i >> 2)) + ".int32[" + (i & 3) + "]", a.xmm_high[i], b.xmm_high[i]);
    }

    check("fpu tag", a.fpu_tag, b.fpu_tag);
    check("fpu status", a.fpu_status, b.fpu_status);
    for(let i = 0; i < a.fpu_st.length; i++)
    {
        check("fpu_st/mm.int32[" + i + "]", a.fpu_st[i], b.fpu_st[i]);
    }

    for(let i = 0; i < a.mem.length; i++)
    {
        check("mem[" + h(gen.SCRATCH_ADDR + 4 * i, 8) + "]", a.mem[i], b.mem[i]);
    }

    if(a.low_mem && b.low_mem)
    {
        for(let i = 0; i < a.low_mem.length; i++)
        {
            check("lowmem[" + h(4 * i, 8) + "]", a.low_mem[i], b.low_mem[i]);
        }
    }

    return failures;
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

// After a crash/timeout the emulator may be wedged; discard it (its tick
// loop is dead) and create a fresh one.
async function recreate_emulator()
{
    try
    {
        emulator.v86.stop();
    }
    catch(e) { /* already dead */ }
    emulator = create_emulator();
    await emulator_loaded(emulator);
}

async function main()
{
    emulator = create_emulator();
    await emulator_loaded(emulator);

    const ops = [];
    let skipped_count = 0;
    for(const op of table)
    {
        if(!gen.is_fuzzable(op))
        {
            skipped_count++;
            continue;
        }
        for(const config of gen.fuzz_configs(op))
        {
            ops.push({ op, config });
        }
    }

    if(WORKER_INDEX === 0)
    {
        console.log("Fuzzing %d instruction encodings (%d table entries skipped), seed=%d, cases per config=%d",
            ops.length, skipped_count, FUZZ_SEED, FUZZ_CASES);
    }

    if(TEST_RELEASE_BUILD)
    {
        console.log("Note: release build: JIT force-compilation unavailable, " +
            "running interpreter smoke test only (no differential comparison)");
    }

    let cases_run = 0;
    let failures = 0;
    let case_index = 0;

    outer:
    for(const { op, config } of ops)
    {
        for(let nth = 0; nth < FUZZ_CASES; nth++)
        {
            const seed = gen.case_seed(FUZZ_SEED, op, config, nth);
            const test_case = gen.generate_case(op, config, seed, nth);

            if(!TEST_NAME.test(test_case.name))
            {
                continue;
            }

            if(case_index++ % WORKER_TOTAL !== WORKER_INDEX)
            {
                continue;
            }

            if(process.env.SHOW_CASES)
            {
                console.error("case %s seed=%d instr: %s", test_case.name, seed,
                    hex_bytes(test_case.instr_bytes));
            }

            let interp_state = null;
            let interp_error = null;
            try
            {
                interp_state = await run_variant(test_case, false);
            }
            catch(e)
            {
                interp_error = e;
                await recreate_emulator();
            }

            if(TEST_RELEASE_BUILD)
            {
                // smoke only
                if(interp_error)
                {
                    console.error("[-] CRASH %s (seed=%d, replay: FUZZ_SEED=%d TEST_NAME=^%s$): %s",
                        test_case.name, seed, FUZZ_SEED, test_case.name,
                        String(interp_error && interp_error.message || interp_error).split("\n")[0]);
                    console.error("    instruction bytes: %s", hex_bytes(test_case.instr_bytes));
                    failures++;
                }
                cases_run++;
                if(cases_run >= FUZZ_MAX_CASES) break outer;
                continue;
            }

            let jit_state = null;
            let jit_error = null;
            try
            {
                jit_state = await run_variant(test_case, true);
            }
            catch(e)
            {
                jit_error = e;
                await recreate_emulator();
            }

            cases_run++;

            if(interp_error || jit_error)
            {
                failures++;
                const which = interp_error && jit_error ? "both engines" :
                    interp_error ? "interpreter" : "jit";
                console.error("[-] CRASH %s (seed=%d, replay: FUZZ_SEED=%d TEST_NAME=^%s$) in %s:",
                    test_case.name, seed, FUZZ_SEED, test_case.name, which);
                console.error("    instruction bytes: %s", hex_bytes(test_case.instr_bytes));
                console.error("    interp: %s", interp_error ?
                    String(interp_error && interp_error.message || interp_error).split("\n")[0] : "(ok)");
                console.error("    jit:    %s", jit_error ?
                    String(jit_error && jit_error.message || jit_error).split("\n")[0] : "(ok)");
                if(process.env.SHOW_CRASH_STACK)
                {
                    for(const e of [interp_error, jit_error])
                    {
                        if(e && e.stack)
                        {
                            console.error(String(e.stack).split("\n").slice(1, 14)
                                .map(l => "        " + l.trim()).join("\n"));
                        }
                    }
                }
                continue;
            }

            const case_failures = compare_states(test_case.name, interp_state, jit_state);
            if(case_failures.length)
            {
                failures++;

                console.error("[-] MISMATCH %s (seed=%d, replay: FUZZ_SEED=%d TEST_NAME=^%s$)",
                    test_case.name, seed, FUZZ_SEED, test_case.name);
                console.error("    instruction bytes: %s", hex_bytes(test_case.instr_bytes));
                for(const f of case_failures.slice(0, 10))
                {
                    console.error("    %s: interp=%s jit=%s", f.name,
                        format_value(f.interp), format_value(f.jit));
                }
                if(case_failures.length > 10)
                {
                    console.error("    ... and %d more", case_failures.length - 10);
                }
            }

            if(cases_run >= FUZZ_MAX_CASES) break outer;
        }
    }

    console.log("\n[+] worker %d: %d/%d cases passed (%d instruction configs, seed=%d)",
        WORKER_INDEX, cases_run - failures, cases_run, ops.length, FUZZ_SEED);

    await emulator.destroy();

    if(failures > 0)
    {
        console.error("[-] worker %d: %d case(s) diverged or crashed", WORKER_INDEX, failures);
        process.exit(1);
    }
    process.exit(0);
}

if(!IS_WORKER && cluster.isPrimary)
{
    const workers = Math.max(1, Math.min(os.cpus().length || 1,
        +process.env.MAX_PARALLEL_TESTS || 9999));
    console.log("Fuzzing with %d worker(s), seed=%d, cases per config=%d",
        workers, FUZZ_SEED, FUZZ_CASES);

    let exited = 0;
    let failed = 0;
    for(let i = 0; i < workers; i++)
    {
        const worker = cluster.fork({
            FUZZ_WORKER_INDEX: String(i),
            FUZZ_WORKER_TOTAL: String(workers),
        });
        worker.on("exit", code =>
        {
            if(code !== 0) failed++;
            exited++;
            if(exited === workers)
            {
                if(failed)
                {
                    console.log("[-] %d/%d workers reported failures", failed, workers);
                }
                else
                {
                    console.log("[+] all %d workers passed", workers);
                }
                process.exit(failed ? 1 : 0);
            }
        });
    }
}
else
{
    main().catch(e =>
    {
        console.error(e);
        process.exit(1);
    });
}
