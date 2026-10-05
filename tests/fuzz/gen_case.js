// Instruction fuzz case generator.
//
// Generates small self-contained multiboot images that:
//   1. (64-bit cases) enter long mode via a 32-bit stub (page tables, PAE,
//      EFER.LME, paging, far jump into a 64-bit code segment)
//   2. initialise GPRs, x87/MMX, XMM and eflags to pseudo-random values
//   3. execute a single fuzzed instruction with random operands/encoding
//   4. hlt
//
// The instruction set under test is enumerated from gen/x86_table.js, the
// same table that drives the interpreter/jit generators, so every
// implemented instruction is covered.
//
// 64-bit edge cases covered: REX.W/R/X/B combinations (r8-r15, xmm8-xmm15,
// sil/dil/bpl/spl vs ah/ch/dh/bh), 16/32/64-bit operand sizes, RIP-relative
// addressing with computed displacements, address-size override (0x67) with
// garbage upper address bits, non-canonical addresses (expect #GP), wild
// displacements (expect #PF/#GP), imm64 moves, 64-bit moffs, misaligned SSE
// operands, 64-bit shift counts and 32-bit result zero-extension.
//
// Used by run.js, which executes each case in the interpreter and in the
// JIT and compares the resulting CPU state.

import encodings from "../../gen/x86_table.js";
import Rand from "../nasm/rand.js";

export const LOAD_ADDR = 0x80000;
export const SCRATCH_ADDR = 0x100000;
export const SCRATCH_SIZE = 0x2000;

// long mode page tables (identity map of the first 2 MiB), written by the driver
export const PML4_ADDR = 0x10000;
export const PDPT_ADDR = 0x11000;
export const PD_ADDR = 0x12000;

const STACK_TOP = SCRATCH_ADDR + SCRATCH_SIZE;
const HEADER_SIZE = 0x20;

const MULTIBOOT_HEADER_MAGIC = 0x1BADB002;
const MULTIBOOT_HEADER_ADDRESS = 0x10000;

// bits that must not be set by the random eflags value pushed in the prologue
const FLAGS_MASK_OUT = (1 << 8) | (1 << 9) | (1 << 14) | (1 << 16) | (1 << 17); // TF IF NT RF VM

const REG_ESP = 4;

// all regs except rsp (indices 0-15; 0-7 are eax..edi, 8-15 are r8-r15)
function all_gprs(mode)
{
    const n = mode === 64 ? 16 : 8;
    const r = [];
    for(let i = 0; i < n; i++)
    {
        if(i !== REG_ESP) r.push(i);
    }
    return r;
}

// Instructions the linear single-instruction harness cannot support, even if
// the table doesn't mark them as skip: anything that redirects control flow
// or interacts with the (asynchronous, non-deterministic) environment.
const DENY_OPCODES = new Set([
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, // jcc rel8
    0x78, 0x79, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F,
    0xE0, 0xE1, 0xE2, 0xE3,                         // loopne/loope/loop/jcxz
    0xE8, 0xE9, 0xEA, 0xEB,                         // call/jmp rel/far
    0x9A,                                           // callf
    0xC2, 0xC3, 0xCA, 0xCB,                         // ret
    0xCC, 0xCD, 0xCE, 0xCF,                         // int/into/iret
    0xF1, 0xF4,                                     // int1/hlt
    0x0F05, 0x0F07, 0x0F34, 0x0F35,                 // syscall/sysret/sysenter/sysexit
    0x0F31,                                         // rdtsc (non-deterministic)
]);
for(let i = 0; i < 0x10; i++) DENY_OPCODES.add(0x0F80 | i); // jcc rel16/32

// opcodes whose low 3 bits encode a register (no modrm); the register can be
// extended to r8-r15 with REX.B in 64-bit mode
const OPCODE_REG_BASES = new Set([0x50, 0x58, 0x90, 0xB0, 0xB8]);

function has_opcode_reg(op)
{
    return !op.e && op.fixed_g === undefined &&
        OPCODE_REG_BASES.has(op.opcode & ~7) && op.opcode < 0x100;
}

function interesting_immediate(rng)
{
    if(rng.int32() & 1)
    {
        return rng.int32();
    }
    else
    {
        // small/shifted values: more likely to hit edge cases
        return rng.int32() << (rng.int32() & 31) >> (rng.int32() & 31);
    }
}

// 64-bit immediate as [lo, hi] int32 pair, biased towards edge cases
const EDGE_LOHI = [
    [0, 0], [1, 0], [-1, -1], [0, -1], [-1, 0],
    [0x7FFFFFFF | 0, 0], [0x80000000 | 0, 0], [0xFFFFFFFF | 0, 0],
    [0, 1], [0, 0x80000000 | 0], [0, 0x7FFFFFFF], [-1, 0x7FFFFFFF],
    [0x3F, 0], [0x40, 0], [0x20, 0],
];
function interesting_immediate64(rng)
{
    if(rng.uint32() & 1)
    {
        return EDGE_LOHI[rng.uint32() % EDGE_LOHI.length];
    }
    return [interesting_immediate(rng), interesting_immediate(rng)];
}

/**
 * Is this table entry fuzzable by the single-instruction harness?
 */
export function is_fuzzable(op)
{
    if(op.prefix || op.skip)
    {
        return false;
    }
    if(DENY_OPCODES.has(op.opcode))
    {
        return false;
    }
    if(op.opcode === 0xFF && op.fixed_g !== undefined && op.fixed_g >= 2 && op.fixed_g <= 5)
    {
        // call/jmp r/m
        return false;
    }
    return true;
}

/**
 * The applicable { mode, size, mem } configurations for an instruction.
 * mode: 32 or 64 (long mode); size: operand size; mem: use the memory
 * operand form.
 */
export function fuzz_configs(op)
{
    const configs = [];
    for(const mode of [32, 64])
    {
        if(mode === 64 && op.opcode >= 0x40 && op.opcode <= 0x4F && op.opcode < 0x100)
        {
            // single-byte inc/dec are REX prefixes in long mode
            continue;
        }
        for(const mem of [0, 1])
        {
            if(mem ? op.skip_mem : op.skip_reg)
            {
                continue;
            }
            if(!op.e && mem)
            {
                // doesn't use memory, don't test both
                continue;
            }

            const sized = op.os || op.opcode % 2 === 1;
            let sizes;
            if(!sized)
            {
                sizes = [8];
            }
            else if(mode === 32)
            {
                sizes = [16, 32];
            }
            else
            {
                sizes = op.d64 ? [16, 64] : [16, 32, 64];
            }

            for(const size of sizes)
            {
                configs.push({ mode, size, mem });
            }
        }
    }
    return configs;
}

export function format_opcode(n)
{
    let x = n.toString(16);
    return (x.length === 1 || x.length === 3) ? "0" + x : x;
}

// three-byte maps: e.g. 660f3800 for 66 0F 38 00
export function format_encoding(op)
{
    if(!op.map)
    {
        return format_opcode(op.opcode);
    }
    return format_opcode(op.opcode >> 8) + op.map.toString(16) + format_opcode(op.opcode & 0xFF).padStart(2, "0");
}

export function case_name(op, config, nth)
{
    return "fuzz" + config.mode + "_" + format_encoding(op) + "_" +
        (op.fixed_g === undefined ? "r" : op.fixed_g) + "_" +
        config.size + (config.mem ? "m" : "r") + "_" + nth;
}

/**
 * Deterministic seed for a case.
 */
export function case_seed(global_seed, op, config, nth)
{
    let h = global_seed >>> 0;
    h = Math.imul(h ^ (op.opcode >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((op.fixed_g || 0) * 31 + config.size * 3 + config.mem + config.mode * 7), 0x01000193) >>> 0;
    h = Math.imul(h ^ nth, 0x01000193) >>> 0;
    h = Math.imul(h ^ (op.map || 0), 0x01000193) >>> 0;
    return h >>> 0;
}

class Emitter
{
    constructor()
    {
        this.bytes = [];
    }
    u8(v) { this.bytes.push(v & 0xFF); }
    u16(v) { this.u8(v); this.u8(v >> 8); }
    u32(v) { this.u16(v); this.u16(v >>> 16); }
    u64(lo, hi) { this.u32(lo); this.u32(hi); }
    at()
    {
        // current absolute guest address
        return LOAD_ADDR + HEADER_SIZE + this.bytes.length;
    }
    align(n)
    {
        while((this.at() & (n - 1)) !== 0) this.u8(0x90);
    }
    patch_u32(byte_offset, v)
    {
        this.bytes[byte_offset] = v & 0xFF;
        this.bytes[byte_offset + 1] = v >> 8 & 0xFF;
        this.bytes[byte_offset + 2] = v >> 16 & 0xFF;
        this.bytes[byte_offset + 3] = v >>> 24 & 0xFF;
    }
}

// mov reg, imm32 (32-bit mode prologue)
function emit_mov_reg_imm32(e, reg, value)
{
    e.u8(0xB8 + reg);
    e.u32(value);
}

// mov r64, imm64 (64-bit mode prologue)
function emit_mov_reg_imm64(e, reg, lo, hi)
{
    e.u8(reg >= 8 ? 0x49 : 0x48); // REX.W(+B)
    e.u8(0xB8 + (reg & 7));
    e.u64(lo, hi);
}

/**
 * Generate a random effective address.
 *
 * 32-bit forms: absolute [disp32], [base], [base + disp],
 * [base + index*scale + disp]. Addresses are biased into the scratch region
 * so most accesses hit mapped memory; occasional wild accesses fault
 * deterministically in both engines.
 *
 * 64-bit additionally: RIP-relative (disp patched to land in scratch),
 * SIB-absolute, registers r8-r15 as base/index, address-size override (0x67)
 * with garbage upper base bits, non-canonical base addresses (#GP) and wild
 * displacements (#PF/#GP).
 */
function gen_ea_mem(rng, g, mode)
{
    const n_regs = mode === 64 ? 16 : 8;

    if(mode === 64 && (rng.uint32() & 3) === 0)
    {
        // RIP-relative [rip + disp32] (disp patched by the caller once the
        // instruction length is known)
        return {
            form: "rip",
            modrm: [(g & 7) << 3 | 5],
            disp_placeholder: true,
            base_reg: undefined,
            index_reg: undefined,
            a32: false,
        };
    }

    if((mode === 64 ? rng.uint32() % 5 : rng.uint32() % 4) === 0)
    {
        // absolute [disp32]; in 64-bit encoded via SIB with base=5
        // (mod=0 rm=5 is RIP-relative there)
        const wild = mode === 64 && rng.uint32() % 8 === 0;
        const d = wild ? rng.uint32() : SCRATCH_ADDR + 0x200 + (rng.uint32() % 0x1800);
        const disp = [d & 0xFF, d >> 8 & 0xFF, d >> 16 & 0xFF, d >>> 24 & 0xFF];
        if(mode === 64)
        {
            return {
                form: "abs",
                modrm: [(g & 7) << 3 | 4, 0x25], // sib: scale 0, no index, base 5
                disp,
                base_reg: undefined,
                index_reg: undefined,
                a32: false,
            };
        }
        return {
            form: "abs",
            modrm: [(g & 7) << 3 | 5],
            disp,
            base_reg: undefined,
            index_reg: undefined,
            a32: false,
        };
    }

    const gprs = all_gprs(mode);
    let base_reg = gprs[rng.uint32() % gprs.length];
    let index_reg;
    let use_sib = (rng.uint32() & 1) === 0;

    if((base_reg & 7) === REG_ESP)
    {
        // esp/r12 as base require a SIB
        use_sib = true;
    }

    let mod = rng.uint32() % 3; // 0, 1 or 2
    if((base_reg & 7) === 5 && mod === 0)
    {
        // [ebp/rbp] and [r13] with mod=0 are the disp32-only form;
        // use mod=1 with disp8=0
        mod = 1;
    }

    if(use_sib)
    {
        do { index_reg = rng.uint32() % n_regs; } while((index_reg & 7) === REG_ESP);
    }

    // occasionally exercise the address-size override (0x67) in long mode:
    // EA is truncated to 32 bits, so garbage in the upper half of the base
    // register must be ignored
    const a32 = mode === 64 && (rng.uint32() & 3) === 0;

    // occasionally a non-canonical base (64-bit): must #GP identically in
    // both engines
    const noncanonical = mode === 64 && !a32 && rng.uint32() % 10 === 0;

    const disp = [];
    if(mod === 1)
    {
        disp.push(rng.uint32() & 0xFF);
    }
    else if(mod === 2)
    {
        const d = rng.uint32() % 0x200; // keep close to the scratch region
        disp.push(d & 0xFF, d >> 8 & 0xFF, 0, 0);
    }

    const ea = {
        form: use_sib ? "sib" : "base",
        modrm: [],
        disp,
        base_reg,
        index_reg,
        a32,
        noncanonical,
        scale: rng.uint32() & 3,
        mod,
    };

    if(use_sib)
    {
        ea.modrm.push((mod << 6) | ((g & 7) << 3) | 4);
        ea.modrm.push((ea.scale << 6) | ((index_reg & 7) << 3) | (base_reg & 7));
    }
    else
    {
        ea.modrm.push((mod << 6) | ((g & 7) << 3) | (base_reg & 7));
    }
    return ea;
}

/**
 * The value a prologue register should get, given its role in the effective
 * address (if any). Returns [lo, hi] int32 pair (hi unused in 32-bit mode).
 */
function ea_reg_value(rng, reg, ea, mode)
{
    if(ea && reg === ea.base_reg)
    {
        let offset = 0x200 + (rng.uint32() % 0x1600);
        if(rng.uint32() & 1) offset &= ~0xF;
        const ptr = SCRATCH_ADDR + offset;

        if(ea.noncanonical)
        {
            // bit 47 set with zero upper bits, or canonical-looking high
            // address with bit 47 clear: both non-canonical
            if(rng.uint32() & 1)
            {
                return [(rng.uint32() % 0x1000) | 0, 0x8000];
            }
            return [-(rng.uint32() % 0x1000) | 0, 0xFFFF7FFF | 0];
        }
        if(ea.a32)
        {
            // upper bits must be truncated away by the 0x67 prefix
            return [ptr | 0, rng.int32()];
        }
        return [ptr | 0, 0];
    }
    if(ea && reg === ea.index_reg)
    {
        return [(rng.uint32() % 0x100) | 0, ea.a32 ? rng.int32() : 0];
    }
    if(mode === 64)
    {
        return interesting_immediate64(rng);
    }
    return [interesting_immediate(rng), 0];
}

/**
 * Generate a fuzz case.
 *
 * op: entry from gen/x86_table.js
 * config: { mode: 32|64, size: 8|16|32|64, mem: 0|1 }
 * seed: 32-bit seed
 *
 * Returns { name, mode, image, scratch, instr_bytes, entry64 }:
 *   image: Uint8Array, a multiboot kernel image
 *   scratch: Uint8Array(SCRATCH_SIZE), initial scratch memory contents
 *   instr_bytes: the encoding of the fuzzed instruction itself (for logging)
 *   entry64: (mode 64 only) guest address where 64-bit execution begins
 *            (the driver runs the mode-switch stub first, then resumes here)
 */
export function generate_case(op, config, seed, nth)
{
    const mode = config.mode;
    const rng = new Rand(seed);
    const e = new Emitter();

    // === mode-switch stub (64-bit cases) ===
    let entry64 = 0;
    let gdt_ptr_patch = null;
    let entry64_patch = null;
    if(mode === 64)
    {
        emit_mov_reg_imm32(e, 0, PML4_ADDR);       // mov eax, PML4
        e.u8(0x0F); e.u8(0x22); e.u8(0xD8);        // mov cr3, eax
        e.u8(0x0F); e.u8(0x20); e.u8(0xE0);        // mov eax, cr4
        e.u8(0x0D); e.u32(0x620);                  // or eax, PAE|OSFXSR|OSXMMEXCPT
        e.u8(0x0F); e.u8(0x22); e.u8(0xE0);        // mov cr4, eax
        emit_mov_reg_imm32(e, 1, 0xC0000080);      // mov ecx, EFER
        e.u8(0x0F); e.u8(0x32);                    // rdmsr
        e.u8(0x0D); e.u32(0x100);                  // or eax, LME
        e.u8(0x0F); e.u8(0x30);                    // wrmsr
        e.u8(0x0F); e.u8(0x20); e.u8(0xC0);        // mov eax, cr0
        e.u8(0x0D); e.u32(0x80000001);             // or eax, PG|PE
        e.u8(0x0F); e.u8(0x22); e.u8(0xC0);        // mov cr0, eax
        e.u8(0x0F); e.u8(0x01); e.u8(0x15);        // lgdt [gdt_ptr]
        gdt_ptr_patch = e.bytes.length;
        e.u32(0);
        e.u8(0xEA);                                // jmp far 0x08:entry64
        entry64_patch = e.bytes.length;
        e.u32(0);
        e.u16(0x08);
        entry64 = e.at();
        e.u8(0xF4);                                // hlt: driver resumes here
    }

    // === prologue: random machine state ===

    const size = (op.os || op.opcode % 2 === 1) ? config.size : 8;
    const is_modrm = op.e || op.fixed_g !== undefined;

    // decide operands up front so the prologue can initialise base/index regs
    const n_regs = mode === 64 ? 16 : 8;
    let g = op.fixed_g !== undefined ? op.fixed_g : (rng.uint32() % n_regs);
    let ea = null;
    if(is_modrm)
    {
        if(config.mem)
        {
            ea = gen_ea_mem(rng, g, mode);
        }
        else
        {
            // mod=3 register form (r8-r15 in 64-bit via REX)
            const rm_reg = rng.uint32() % n_regs;
            ea = {
                form: "reg",
                modrm: [0xC0 | ((g & 7) << 3) | (rm_reg & 7)],
                disp: [],
                base_reg: undefined,
                index_reg: undefined,
                rm_reg,
                a32: false,
            };
        }
    }

    // REX.B for opcodes with an embedded register (mov/push/pop/xchg r)
    let opcode_reg_ext = 0;
    if(mode === 64 && has_opcode_reg(op) && (rng.uint32() & 1))
    {
        opcode_reg_ext = 1; // selects r8-r15 variant of the opcode
    }

    // stack pointer: near the top of the scratch region, headroom for pushes
    const sp = STACK_TOP - 0x100 - (rng.uint32() % 0x40);
    if(mode === 64)
    {
        emit_mov_reg_imm64(e, REG_ESP, sp | 0, 0);
    }
    else
    {
        emit_mov_reg_imm32(e, REG_ESP, sp);
    }

    for(const reg of all_gprs(mode))
    {
        const [lo, hi] = ea_reg_value(rng, reg, ea, mode);
        if(mode === 64)
        {
            emit_mov_reg_imm64(e, reg, lo, hi);
        }
        else
        {
            emit_mov_reg_imm32(e, reg, lo);
        }
    }

    // fpu/mmx and xmm state; initialised from a data area embedded in the image
    const fpu_data_refs = []; // byte offsets of disp32 fields
    const xmm_data_refs = [];
    const emit_abs_ref = (refs, g_field) =>
    {
        if(mode === 64)
        {
            // SIB absolute form (mod=0 rm=5 is RIP-relative in long mode)
            refs.push(e.bytes.length + 2);
            e.u8((g_field & 7) << 3 | 4); // modrm
            e.u8(0x25);                   // sib: no index, base 5
            e.u32(0);                     // disp32 placeholder
        }
        else
        {
            refs.push(e.bytes.length + 1);
            e.u8((g_field & 7) << 3 | 5); // modrm: [disp32]
            e.u32(0);
        }
    };

    if(op.is_fpu)
    {
        e.u8(0xDB); e.u8(0xE3); // finit
        for(let i = 0; i < 8; i++)
        {
            e.u8(0xDD); // fld qword [data]
            emit_abs_ref(fpu_data_refs, 0);
        }
        for(let i = 0; i < 4; i++)
        {
            // fstp qword [scratch]: half-empty fpu stack
            e.u8(0xDD);
            if(mode === 64)
            {
                e.u8(0x1C); e.u8(0x25);
            }
            else
            {
                e.u8(0x1D);
            }
            e.u32(SCRATCH_ADDR + 0x1F00);
        }
    }
    else
    {
        for(let i = 0; i < 8; i++)
        {
            e.u8(0x0F); e.u8(0x6F); // movq mm<i>, [data]
            emit_abs_ref(fpu_data_refs, i);
        }
    }

    const n_xmm = mode === 64 ? 16 : 8;
    for(let i = 0; i < n_xmm; i++)
    {
        // movdqu xmm<i>, [data]
        e.u8(0xF3);
        if(i >= 8) e.u8(0x44); // REX.R
        e.u8(0x0F); e.u8(0x6F);
        emit_abs_ref(xmm_data_refs, i & 7);
    }

    // random eflags (TF/IF/NT/RF/VM masked out); push imm32; popf also works
    // in long mode (sign-extended imm32, popfq)
    e.u8(0x68);
    e.u32(rng.int32() & ~FLAGS_MASK_OUT);
    e.u8(0x9D);

    if(rng.int32() & 1)
    {
        // set flags via an arithmetic instruction: not well-distributed,
        // but can trigger bugs in lazy flag calculation
        if(rng.int32() & 1)
        {
            e.u8(0x02); e.u8(0xC4); // add al, ah
        }
        else
        {
            e.u8(0x2A); e.u8(0xC0); // sub al, al
        }
    }

    if(op.is_string)
    {
        // constrain string ops to the scratch region
        const ecx = 1 + rng.uint32() % 4;
        const edi = SCRATCH_ADDR + 0x1000 + (rng.uint32() % 0x100);
        const esi = SCRATCH_ADDR + 0x800 + (rng.uint32() % 0x100);
        if(mode === 64)
        {
            emit_mov_reg_imm64(e, 1, ecx, 0);
            emit_mov_reg_imm64(e, 7, edi, 0);
            emit_mov_reg_imm64(e, 6, esi, 0);
        }
        else
        {
            emit_mov_reg_imm32(e, 1, ecx);
            emit_mov_reg_imm32(e, 7, edi);
            emit_mov_reg_imm32(e, 6, esi);
        }
    }

    if([0x0FA5, 0x0FAD].includes(op.opcode) && size === 16)
    {
        // shld/shrd cl: shift counts larger than opsize are undefined, but
        // the count is anded with opsize-1, so only bit 4 needs clearing
        e.u8(0x80); e.u8(0xE1); e.u8(~16 & 0xFF); // and cl, ~16
    }

    // === the fuzzed instruction ===

    const instr_start = e.bytes.length;

    if(ea && ea.a32)
    {
        e.u8(0x67); // 32-bit addressing in long mode
    }
    if(size === 16)
    {
        e.u8(0x66);
    }

    let opcode = op.opcode;
    let legacy_prefix = 0;
    if(opcode >= 0x10000)
    {
        legacy_prefix = opcode >> 16;
        console.assert(legacy_prefix === 0x66 || legacy_prefix === 0xF3 || legacy_prefix === 0xF2,
            "opcode prefix");
        e.u8(legacy_prefix);
        opcode &= ~0xFF0000;
    }

    if(mode === 64)
    {
        // REX prefix: after legacy prefixes, before a possible 0F escape
        let rex = 0x40;
        if(size === 64) rex |= 8;                    // W
        if(g >= 8) rex |= 4;                        // R
        if(ea && ea.index_reg >= 8) rex |= 2;       // X
        if(ea && (ea.form === "reg" ? ea.rm_reg >= 8 : ea.base_reg >= 8)) rex |= 1; // B
        if(opcode_reg_ext) rex |= 1;                // B (opcode-embedded reg)
        if(rex !== 0x40 || (size === 8 && is_modrm && (rng.uint32() & 3) === 0))
        {
            // bare REX is emitted occasionally for byte ops: reg/rm 4-7
            // encode spl/bpl/sil/dil instead of ah/ch/dh/bh
            e.u8(rex);
        }
    }

    if(opcode >= 0x100)
    {
        e.u8(opcode >> 8); // 0x0F (or F2/F3 for the rep string entries)
        opcode &= 0xFF;
        if(op.map)
        {
            e.u8(op.map);
        }
    }
    e.u8(opcode);

    let rip_disp_patch = -1;
    if(ea)
    {
        for(const b of ea.modrm) e.u8(b);
        if(ea.disp_placeholder)
        {
            rip_disp_patch = e.bytes.length;
            e.u32(0);
        }
        else
        {
            for(const b of ea.disp) e.u8(b);
        }
    }

    if(op.opcode === 0xC8) // enter: small frame, nesting level 0
    {
        e.u16(rng.uint32() % 0x400);
        e.u8(0);
    }
    else if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8 || op.imm8s)
        {
            if([0x0FA4, 0x0FAC].includes(op.opcode))
            {
                // shld/shrd imm: counts larger than opsize are undefined
                e.u8(rng.uint32() & (size === 16 ? 15 : size === 64 ? 63 : 31));
            }
            else
            {
                e.u8(rng.uint32());
            }
        }
        else if(op.immaddr)
        {
            // moffs: 64-bit absolute address in long mode
            const addr = SCRATCH_ADDR + 0x200 + (rng.uint32() % 0x1800);
            if(mode === 64)
            {
                e.u64(addr, 0);
            }
            else
            {
                e.u32(addr);
            }
        }
        else if(op.imm3264 && size === 64)
        {
            // mov r64, imm64
            const [lo, hi] = interesting_immediate64(rng);
            e.u64(lo, hi);
        }
        else if(op.imm16 || (op.imm1632 && size === 16))
        {
            e.u16(rng.uint32() & 0xFFFF);
        }
        else
        {
            e.u32(rng.int32());
        }
        if(op.extra_imm8)
        {
            e.u8(rng.uint32());
        }
        else if(op.extra_imm16)
        {
            e.u16(rng.uint32() & 0xFFFF);
        }
    }

    if(rip_disp_patch >= 0)
    {
        // RIP-relative: disp32 is relative to the next instruction
        const target = SCRATCH_ADDR + 0x200 + (rng.uint32() % 0x1800);
        const next_rip = LOAD_ADDR + HEADER_SIZE + e.bytes.length;
        e.patch_u32(rip_disp_patch, target - next_rip | 0);
    }

    const instr_bytes = e.bytes.slice(instr_start);

    // hlt (+ padding: a RIP-relative write may land here, keep it harmless)
    e.u8(0xF4);
    for(let i = 0; i < 64; i++) e.u8(0xF4);

    // === data area ===
    e.align(16);
    const fpu_data_addr = e.at();
    const fpu_data = [];
    for(let i = 0; i < 16; i++) fpu_data.push(rng.int32());
    const xmm_data_addr = fpu_data_addr + 64;
    const xmm_data = [];
    for(let i = 0; i < n_xmm * 4; i++) xmm_data.push(rng.int32());

    for(const [i, off] of fpu_data_refs.entries())
    {
        e.patch_u32(off, fpu_data_addr + i * 8);
    }
    for(const [i, off] of xmm_data_refs.entries())
    {
        e.patch_u32(off, xmm_data_addr + i * 16);
    }

    for(const v of fpu_data) e.u32(v);
    for(const v of xmm_data) e.u32(v);

    if(mode === 64)
    {
        // gdt: null, 64-bit code (0x08), data (0x10)
        e.align(16);
        const gdt_addr = e.at();
        e.u64(0, 0);
        e.u64(0x0000FFFF | 0, 0x00AF9A00); // code64: L=1, D=0, P, type=exec/read
        e.u64(0x0000FFFF | 0, 0x00CF9200); // data: G=1, D/B=1, P, type=read/write
        const gdt_ptr_addr = e.at();
        e.patch_u32(gdt_ptr_patch, gdt_ptr_addr);
        e.u16(3 * 8 - 1);      // limit
        e.u32(gdt_addr);       // base (32-bit lgdt)
        e.patch_u32(entry64_patch, entry64);
    }

    // random initial scratch memory contents
    const scratch = new Uint8Array(SCRATCH_SIZE);
    for(let i = 0; i < SCRATCH_SIZE; i += 4)
    {
        const v = rng.uint32();
        scratch[i] = v & 0xFF;
        scratch[i + 1] = v >> 8 & 0xFF;
        scratch[i + 2] = v >> 16 & 0xFF;
        scratch[i + 3] = v >>> 24 & 0xFF;
    }

    // === multiboot image ===
    const image = new Uint8Array(HEADER_SIZE + e.bytes.length);
    const view = new DataView(image.buffer);
    image.set(e.bytes, HEADER_SIZE);
    const load_end = LOAD_ADDR + image.length;
    view.setUint32(0, MULTIBOOT_HEADER_MAGIC, true);
    view.setUint32(4, MULTIBOOT_HEADER_ADDRESS, true);
    view.setUint32(8, -(MULTIBOOT_HEADER_MAGIC + MULTIBOOT_HEADER_ADDRESS) | 0, true);
    view.setUint32(12, LOAD_ADDR, true);            // header_addr
    view.setUint32(16, LOAD_ADDR, true);            // load_addr
    view.setUint32(20, load_end, true);             // load_end_addr
    view.setUint32(24, load_end, true);             // bss_end_addr
    view.setUint32(28, LOAD_ADDR + HEADER_SIZE, true); // entry_addr

    return {
        name: case_name(op, config, nth === undefined ? 0 : nth),
        mode,
        image,
        scratch,
        instr_bytes: new Uint8Array(instr_bytes),
        entry64,
    };
}
