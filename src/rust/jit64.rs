#![allow(non_snake_case)]

//! Code generation for 64-bit (long mode) code.
//!
//! The 64-bit jit shares the block finder, control flow structuring and module generation with
//! the 32-bit jit (see jit.rs), but has its own instruction table (gen/generate_jit64.js). In this
//! first version the guest registers stay in memory, and instructions are compiled to calls of
//! generated wrappers (gen/jit64_wrappers.rs) around the interpreter's instruction handlers, with
//! the instruction already decoded: operands are passed as constants and memory addresses are
//! computed inline. This removes the interpreter's fetch/decode/dispatch overhead and lets
//! control flow (jumps, loops, calls within a page) stay inside the compiled module.
//!
//! The wrappers set up the instruction pointer and prefixes like the interpreter would and
//! return whether the compiled code has to be left: when the instruction raised an exception
//! (the interpreter delivers it immediately, see JIT64_EXIT), or wrote to a page containing
//! compiled code.

use crate::codegen;
use crate::cpu::cpu;
use crate::cpu::global_pointers;
use crate::cpu_context::CpuContext;
use crate::gen;
use crate::jit::{JitContext, JIT_INSTR_BLOCK_BOUNDARY_FLAG};
use crate::prefix::{
    PREFIX_66, PREFIX_67, PREFIX_F2, PREFIX_F3, PREFIX_MASK_REX, PREFIX_MASK_SEGMENT,
    PREFIX_REX_PRESENT, PREFIX_REX_W,
};
use crate::regs::{CS, DS, ES, FS, GS, SS};

/// Set when the interpreter delivers an exception or interrupt, or when a page with compiled
/// code is written to: the 64-bit jit must not continue with the rest of the compiled block
pub static mut JIT64_EXIT: bool = false;

/// An argument for a generic instruction call
pub enum A {
    I32(i32),
    I64(u64),
}

/// A decoded memory operand in 64-bit mode (register numbers include the REX extensions)
pub struct Modrm64 {
    base: Option<u32>,
    index: Option<u32>,
    shift: u8,
    disp: i32,
    rip_relative: bool,
}

pub fn decode_modrm(cpu: &mut CpuContext, modrm_byte: u8) -> Modrm64 {
    dbg_assert!(modrm_byte < 0xC0);
    let md = modrm_byte >> 6;
    let rm = modrm_byte & 7;

    let mut m = Modrm64 {
        base: None,
        index: None,
        shift: 0,
        disp: 0,
        rip_relative: false,
    };

    if rm == 4 {
        let sib = cpu.read_imm8();
        let base = sib & 7;
        let index = (sib >> 3 & 7) as u32 | cpu.rex_x();
        m.shift = sib >> 6;
        // index 4 (rsp) means no index, but r12 (4 with REX.X) is a valid index
        m.index = if index == 4 { None } else { Some(index) };
        if base == 5 && md == 0 {
            m.disp = cpu.read_imm32() as i32;
            return m;
        }
        m.base = Some(base as u32 | cpu.rex_b());
    }
    else if rm == 5 && md == 0 {
        m.rip_relative = true;
        m.disp = cpu.read_imm32() as i32;
        return m;
    }
    else {
        m.base = Some(rm as u32 | cpu.rex_b());
    }

    m.disp = match md {
        0 => 0,
        1 => cpu.read_imm8s() as i32,
        _ => cpu.read_imm32() as i32,
    };
    m
}

pub fn skip_modrm(cpu: &mut CpuContext, modrm_byte: u8) {
    if modrm_byte < 0xC0 {
        let _ = decode_modrm(cpu, modrm_byte);
    }
}

/// Generate the effective address (without segment base) of a memory operand as an i64.
/// Must be called after all of the instruction's bytes have been read (rip-relative operands
/// are relative to the end of the instruction).
pub fn gen_modrm_offset(ctx: &mut JitContext, m: &Modrm64) {
    if m.rip_relative {
        // the page of the instruction is the page of instruction_pointer
        codegen::gen_get_eip64(ctx.builder);
        ctx.builder.const_i64(!0xFFF);
        ctx.builder.and_i64();
        ctx.builder
            .const_i64((ctx.cpu.eip & 0xFFF) as i64 + m.disp as i64);
        ctx.builder.add_i64();
        return;
    }

    let mut have_something_on_stack = false;
    if let Some(base) = m.base {
        ctx.builder
            .load_fixed_i64(global_pointers::get_reg64_offset(base));
        have_something_on_stack = true;
    }
    if let Some(index) = m.index {
        ctx.builder
            .load_fixed_i64(global_pointers::get_reg64_offset(index));
        if m.shift != 0 {
            ctx.builder.const_i64(m.shift as i64);
            ctx.builder.shl_i64();
        }
        if have_something_on_stack {
            ctx.builder.add_i64();
        }
        have_something_on_stack = true;
    }
    if m.disp != 0 || !have_something_on_stack {
        ctx.builder.const_i64(m.disp as i64);
        if have_something_on_stack {
            ctx.builder.add_i64();
        }
    }
}

/// Generate the linear address of a memory operand as an i64: in 64-bit mode only fs and gs
/// have a segment base
pub fn gen_modrm_address(ctx: &mut JitContext, m: &Modrm64) {
    gen_modrm_offset(ctx, m);
    let segment_prefix = ctx.cpu.prefixes & PREFIX_MASK_SEGMENT;
    if segment_prefix == FS as u16 + 1 {
        ctx.builder.load_fixed_i64(global_pointers::fs_base as u32);
        ctx.builder.add_i64();
    }
    else if segment_prefix == GS as u16 + 1 {
        ctx.builder.load_fixed_i64(global_pointers::gs_base as u32);
        ctx.builder.add_i64();
    }
}

/// Start and end of the current instruction within its page, packed for the wrappers
fn instruction_ips(ctx: &JitContext) -> i32 {
    (ctx.start_of_current_instruction & 0xFFF | (ctx.cpu.eip & 0xFFF) << 12) as i32
}

/// Call a generated wrapper (jit64_*) for an instruction that is run by the interpreter's
/// handler, and leave the compiled code if it raised an exception.
/// mem: the memory operand, passed as the first argument
fn gen_call_wrapper(ctx: &mut JitContext, name: &str, mem: Option<&Modrm64>, args: &[A]) {
    ctx.builder.const_i32(instruction_ips(ctx));
    ctx.builder.const_i32(ctx.cpu.prefixes as i32);

    let mut first_is_i64 = false;
    if let Some(m) = mem {
        gen_modrm_address(ctx, m);
        first_is_i64 = true;
    }
    let mut i32_args = 0;
    for (i, arg) in args.iter().enumerate() {
        match *arg {
            A::I32(x) => {
                ctx.builder.const_i32(x);
                i32_args += 1;
            },
            A::I64(x) => {
                dbg_assert!(i == 0 && mem.is_none(), "only the first argument can be 64-bit");
                ctx.builder.const_i64(x as i64);
                first_is_i64 = true;
            },
        }
    }

    match (first_is_i64, i32_args) {
        (false, 0) => ctx.builder.call_fn2_ret(name),
        (false, 1) => ctx.builder.call_fn3_ret(name),
        (false, 2) => ctx.builder.call_fn4_ret(name),
        (false, 3) => ctx.builder.call_fn5_ret(name),
        (true, 0) => ctx.builder.call_fn3_i32_i32_i64_ret(name),
        (true, 1) => ctx.builder.call_fn4_i32_i32_i64_i32_ret(name),
        (true, 2) => ctx.builder.call_fn5_i32_i32_i64_i32_i32_ret(name),
        _ => {
            dbg_assert!(false, "unsupported wrapper signature");
        },
    }
    ctx.builder.br_if(ctx.exit_label);
}

pub fn gen_generic(ctx: &mut JitContext, name: &str, args: &[A]) {
    gen_call_wrapper(ctx, name, None, args)
}
pub fn gen_generic_mem(ctx: &mut JitContext, name: &str, m: &Modrm64, args: &[A]) {
    gen_call_wrapper(ctx, name, Some(m), args)
}

/// Run the current instruction in the interpreter (for encodings that the 64-bit jit doesn't
/// decode itself), then leave the compiled code. Its bytes must have been consumed by the caller.
pub fn gen_interpret_one(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.builder
        .const_i32((ctx.start_of_current_instruction & 0xFFF) as i32);
    ctx.builder.call_fn1_ret("jit64_interpret_one");
    ctx.builder.drop_();
    ctx.builder.br(ctx.exit_label);
    *instr_flags |= JIT_INSTR_BLOCK_BOUNDARY_FLAG;
}

// ---------------------------------------------------------------------------------------------
// Instruction decoding entry points and prefixes

pub fn jit_instruction(ctx: &mut JitContext, instr_flags: &mut u32) {
    ctx.cpu.prefixes = 0;
    ctx.start_of_current_instruction = ctx.cpu.eip;
    jit_opcode(ctx, instr_flags);
}

/// Read and compile an opcode (after any legacy prefixes): REX prefixes and operand size tier
/// selection as in analysis::analyze_opcode64
fn jit_opcode(ctx: &mut JitContext, instr_flags: &mut u32) {
    let opcode = ctx.cpu.read_imm8() as u32;
    if opcode & 0xF0 == 0x40 {
        ctx.cpu.prefixes = ctx.cpu.prefixes & !PREFIX_MASK_REX
            | PREFIX_REX_PRESENT
            | ((opcode as u16 & 0xF) << 8);
        return jit_opcode(ctx, instr_flags);
    }
    let tier = if ctx.cpu.prefixes & PREFIX_REX_W != 0
        || ctx.cpu.osize_32() && gen::interpreter::is_default_64_operand_size(opcode)
    {
        0x200
    }
    else {
        (ctx.cpu.osize_32() as u32) << 8
    };
    gen::jit64::jit(opcode | tier, ctx, instr_flags)
}

fn jit_handle_prefix(ctx: &mut JitContext, instr_flags: &mut u32) {
    if ctx.cpu.prefixes & PREFIX_67 != 0 {
        // 32-bit addressing in 64-bit mode: rare, leave it to the interpreter. The analyzer has
        // made this instruction a block boundary (see analysis::fixup_analysis64)
        let mut analysis_cpu = ctx.cpu.clone();
        let mut analysis = crate::analysis::Analysis {
            no_next_instruction: false,
            absolute_jump: false,
            ty: crate::analysis::AnalysisType::Normal,
        };
        crate::analysis::analyze_opcode64(&mut analysis_cpu, &mut analysis);
        ctx.cpu.eip = analysis_cpu.eip;
        return gen_interpret_one(ctx, instr_flags);
    }
    jit_opcode(ctx, instr_flags)
}

fn jit_handle_segment_prefix(segment: u32, ctx: &mut JitContext, instr_flags: &mut u32) {
    dbg_assert!(segment <= 5);
    ctx.cpu.prefixes =
        ctx.cpu.prefixes & !(PREFIX_MASK_SEGMENT | PREFIX_MASK_REX) | (segment as u16 + 1);
    jit_handle_prefix(ctx, instr_flags)
}

pub fn instr_26_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(ES, ctx, f) }
pub fn instr_2E_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(CS, ctx, f) }
pub fn instr_36_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(SS, ctx, f) }
pub fn instr_3E_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(DS, ctx, f) }
pub fn instr_64_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(FS, ctx, f) }
pub fn instr_65_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_segment_prefix(GS, ctx, f) }

fn jit_handle_legacy_prefix(prefix: u16, ctx: &mut JitContext, f: &mut u32) {
    // a legacy prefix after a REX prefix annuls the REX prefix
    ctx.cpu.prefixes = ctx.cpu.prefixes & !PREFIX_MASK_REX | prefix;
    jit_handle_prefix(ctx, f)
}
pub fn instr_66_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_legacy_prefix(PREFIX_66, ctx, f) }
pub fn instr_67_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_legacy_prefix(PREFIX_67, ctx, f) }
pub fn instr_F0_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_legacy_prefix(0, ctx, f) }
pub fn instr_F2_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_legacy_prefix(PREFIX_F2, ctx, f) }
pub fn instr_F3_jit64(ctx: &mut JitContext, f: &mut u32) { jit_handle_legacy_prefix(PREFIX_F3, ctx, f) }

pub fn instr16_0F_jit64(ctx: &mut JitContext, f: &mut u32) {
    let opcode = ctx.cpu.read_imm8() as u32;
    gen::jit64_0f::jit(opcode, ctx, f)
}
pub fn instr32_0F_jit64(ctx: &mut JitContext, f: &mut u32) {
    let opcode = ctx.cpu.read_imm8() as u32;
    if gen::interpreter0f::is_default_64_operand_size(opcode) {
        gen::jit64_0f::jit(opcode | 0x200, ctx, f)
    }
    else {
        gen::jit64_0f::jit(opcode | 0x100, ctx, f)
    }
}
pub fn instr64_0F_jit64(ctx: &mut JitContext, f: &mut u32) {
    let opcode = ctx.cpu.read_imm8() as u32;
    gen::jit64_0f::jit(opcode | 0x200, ctx, f)
}

// ---------------------------------------------------------------------------------------------
// Instructions with custom code generation

/// lea: the effective address without segment base, truncated to the operand size
pub fn instr_8D_jit64(ctx: &mut JitContext, modrm_byte: u8, size: u32) {
    let r = (modrm_byte >> 3 & 7) as u32 | ctx.cpu.rex_r();
    if modrm_byte >= 0xC0 {
        gen_generic(ctx, "jit64_trigger_ud", &[]);
        return;
    }
    let m = decode_modrm(ctx.cpu, modrm_byte);
    let reg = global_pointers::get_reg64_offset(r);
    match size {
        64 => {
            ctx.builder.const_i32(reg as i32);
            gen_modrm_offset(ctx, &m);
            ctx.builder.store_aligned_i64(0);
        },
        32 => {
            // 32-bit destinations are zero-extended
            ctx.builder.const_i32(reg as i32);
            gen_modrm_offset(ctx, &m);
            ctx.builder.wrap_i64_to_i32();
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.store_aligned_i64(0);
        },
        _ => {
            dbg_assert!(size == 16);
            ctx.builder.const_i32(reg as i32);
            gen_modrm_offset(ctx, &m);
            ctx.builder.wrap_i64_to_i32();
            ctx.builder.store_aligned_u16(0);
        },
    }
}

/// call rel32: push the return address. The jump itself is generated by the block glue (the
/// analyzer reports a jump)
pub fn instr64_E8_jit64(ctx: &mut JitContext, _imm: i32) {
    ctx.builder.const_i32(instruction_ips(ctx));
    ctx.builder.call_fn1_ret("jit64_push_return_address");
    ctx.builder.br_if(ctx.exit_label);
}

/// sti: handle_irqs is called by the block glue one instruction later (interrupt shadow)
pub fn instr_FB_jit64(ctx: &mut JitContext) {
    ctx.builder.const_i32(instruction_ips(ctx));
    ctx.builder.call_fn1_ret("jit64_sti");
    ctx.builder.br_if(ctx.exit_label);
}

/// pop r/m: the address is computed after rsp has been incremented, leave it to the interpreter
pub fn instr_8F_jit64(ctx: &mut JitContext, modrm_byte: u8, instr_flags: &mut u32) {
    skip_modrm(ctx.cpu, modrm_byte);
    gen_interpret_one(ctx, instr_flags);
}

pub fn gen_condition_fn(ctx: &mut JitContext, condition: u8) {
    dbg_assert!(condition & 0xF0 == 0x70 || condition & 0xF0 == 0x80);
    ctx.builder.const_i32((condition & 0xF) as i32);
    ctx.builder.call_fn1_ret("jit64_test_cc");
}

// ---------------------------------------------------------------------------------------------
// Runtime support, called from compiled code

/// Set up the cpu state for running an instruction's interpreter handler from compiled code:
/// ips packs the instruction's start (bits 0-11) and end (bits 12-23) within the current page
#[inline(always)]
pub unsafe fn jit64_enter(ips: i32, prefixes: i32) {
    let page = *global_pointers::instruction_pointer & !0xFFF;
    *global_pointers::previous_ip = page | (ips & 0xFFF) as u64;
    *global_pointers::instruction_pointer = page | (ips >> 12 & 0xFFF) as u64;
    *global_pointers::prefixes = prefixes as u16;
    JIT64_EXIT = false;
    #[cfg(debug_assertions)]
    {
        cpu::in_jit = false;
    }
}

#[inline(always)]
pub unsafe fn jit64_leave() -> i32 {
    *global_pointers::prefixes = 0;
    #[cfg(debug_assertions)]
    {
        cpu::in_jit = true;
    }
    JIT64_EXIT as i32
}

#[no_mangle]
pub unsafe fn jit64_push_return_address(ips: i32) -> i32 {
    jit64_enter(ips, 0);
    let _ = crate::cpu::misc_instr::push64(*global_pointers::instruction_pointer);
    jit64_leave()
}

#[no_mangle]
pub unsafe fn jit64_sti(ips: i32) -> i32 {
    jit64_enter(ips, 0);
    if !crate::cpu::instructions::instr_FB_without_fault() {
        cpu::trigger_gp(0);
    }
    jit64_leave()
}

#[no_mangle]
pub unsafe fn jit64_interpret_one(start: i32) -> i32 {
    let page = *global_pointers::instruction_pointer & !0xFFF;
    *global_pointers::instruction_pointer = page | (start & 0xFFF) as u64;
    *global_pointers::previous_ip = *global_pointers::instruction_pointer;
    *global_pointers::prefixes = 0;
    #[cfg(debug_assertions)]
    {
        cpu::in_jit = false;
    }
    cpu::run_shadow_instruction();
    jit64_leave();
    1
}

#[no_mangle]
pub unsafe fn jit64_test_cc(condition: i32) -> i32 {
    use crate::cpu::misc_instr::*;
    let r = match condition & 0xF {
        0x0 => test_o(),
        0x1 => !test_o(),
        0x2 => test_b(),
        0x3 => !test_b(),
        0x4 => test_z(),
        0x5 => !test_z(),
        0x6 => test_be(),
        0x7 => !test_be(),
        0x8 => test_s(),
        0x9 => !test_s(),
        0xA => test_p(),
        0xB => !test_p(),
        0xC => test_l(),
        0xD => !test_l(),
        0xE => test_le(),
        _ => !test_le(),
    };
    r as i32
}

/// After jumping to another page within compiled code: returns 1 if the new page isn't mapped
/// to the physical page the code was compiled for
#[no_mangle]
pub unsafe fn jit_page_switch_check64(next_block_phys: u32) -> i32 {
    match cpu::translate_address_read_no_side_effects(*global_pointers::instruction_pointer) {
        Ok(phys) => (phys != next_block_phys) as i32,
        Err(()) => 1,
    }
}

// ---------------------------------------------------------------------------------------------
// Native code generation: registers (in memory), memory accesses (inline tlb lookup), lazy flags

use crate::cpu::cpu::{
    FLAGS_ALL, FLAG_ADJUST, FLAG_CARRY, FLAG_OVERFLOW, FLAG_SUB, OPSIZE_16, OPSIZE_32, OPSIZE_64,
    OPSIZE_8, TLB_GLOBAL, TLB_HAS_CODE, TLB_HIGH_SIZE, TLB_NOT_EXECUTABLE, TLB_NO_USER,
    TLB_READONLY, TLB_VALID,
};
use crate::prefix::PREFIX_REX_PRESENT as REX_PRESENT;
use crate::wasmgen::wasm_builder::{WasmLocal, WasmLocalI64};

/// A value in a wasm local: i32 for operand sizes up to 32 bits, i64 for 64 bits
pub enum Val {
    I32(WasmLocal),
    I64(WasmLocalI64),
}
impl Val {
    pub fn get(&self, ctx: &mut JitContext) {
        match self {
            Val::I32(l) => ctx.builder.get_local(l),
            Val::I64(l) => ctx.builder.get_local_i64(l),
        }
    }
    pub fn free(self, ctx: &mut JitContext) {
        match self {
            Val::I32(l) => ctx.builder.free_local(l),
            Val::I64(l) => ctx.builder.free_local_i64(l),
        }
    }
}

/// Pop a value of the given operand size from the stack into a new local
pub fn set_new_val(ctx: &mut JitContext, bits: u32) -> Val {
    if bits == 64 {
        Val::I64(ctx.builder.set_new_local_i64())
    }
    else {
        Val::I32(ctx.builder.set_new_local())
    }
}

/// The address of an 8-bit register: with a REX prefix, registers 4-7 are spl/bpl/sil/dil,
/// without they are ah/ch/dh/bh
fn reg8_offset(ctx: &JitContext, r: u32) -> u32 {
    if r >= 4 && r < 8 && ctx.cpu.prefixes & REX_PRESENT == 0 {
        global_pointers::get_reg64_offset(r - 4) + 1
    }
    else {
        global_pointers::get_reg64_offset(r)
    }
}

/// Push a register (zero-extended to i32 for 8 and 16 bits, i64 for 64 bits)
pub fn gen_get_reg(ctx: &mut JitContext, bits: u32, r: u32) {
    match bits {
        8 => {
            let offset = reg8_offset(ctx, r);
            ctx.builder.load_fixed_u8(offset)
        },
        16 => ctx.builder.load_fixed_u16(global_pointers::get_reg64_offset(r)),
        32 => ctx.builder.load_fixed_i32(global_pointers::get_reg64_offset(r)),
        _ => ctx.builder.load_fixed_i64(global_pointers::get_reg64_offset(r)),
    }
}

/// Write a value to a register. 32-bit writes zero-extend into the full 64-bit register,
/// 8- and 16-bit writes leave the other bits unchanged
pub fn gen_set_reg(ctx: &mut JitContext, bits: u32, r: u32, value: &Val) {
    match bits {
        8 => {
            let offset = reg8_offset(ctx, r);
            ctx.builder.const_i32(offset as i32);
            value.get(ctx);
            ctx.builder.store_u8(0);
        },
        16 => {
            ctx.builder
                .const_i32(global_pointers::get_reg64_offset(r) as i32);
            value.get(ctx);
            ctx.builder.store_aligned_u16(0);
        },
        32 => {
            ctx.builder
                .const_i32(global_pointers::get_reg64_offset(r) as i32);
            value.get(ctx);
            ctx.builder.extend_unsigned_i32_to_i64();
            ctx.builder.store_aligned_i64(0);
        },
        _ => {
            ctx.builder
                .const_i32(global_pointers::get_reg64_offset(r) as i32);
            value.get(ctx);
            ctx.builder.store_aligned_i64(0);
        },
    }
}

/// Pops a value and writes it to a register
pub fn gen_set_reg_from_stack(ctx: &mut JitContext, bits: u32, r: u32) {
    let value = set_new_val(ctx, bits);
    gen_set_reg(ctx, bits, r, &value);
    value.free(ctx);
}

fn eip_and_wasm_table_index(ctx: &JitContext) -> i32 {
    (ctx.start_of_current_instruction & 0xFFF) as i32 | (ctx.wasm_table_index.to_u16() as i32) << 16
}

/// Generate the fast path tlb check for a 64-bit address: sets entry (the low 32 bits of the
/// tlb entry) and leaves 1 on the stack if the fast path can be used.
/// Only the tlb for pages at or above 4 GiB (tlb_high_*) is checked inline; accesses to lower
/// addresses take the slow path.
fn gen_tlb_fast_path_check(
    ctx: &mut JitContext,
    bits: u32,
    address: &WasmLocalI64,
    for_writing: bool,
    entry: &WasmLocal,
) {
    // page = canonicalize(address) >> 12
    ctx.builder.get_local_i64(address);
    ctx.builder.const_i64(16);
    ctx.builder.shl_i64();
    ctx.builder.const_i64(28);
    ctx.builder.shr_u_i64();
    let page = ctx.builder.tee_new_local_i64();

    // byte offset of the slot: tlb_high_index(page) * 8
    ctx.builder.const_i64(0x9E37_79B9_7F4A_7C15u64 as i64);
    ctx.builder.mul_i64();
    ctx.builder.const_i64(25 - 3);
    ctx.builder.shr_u_i64();
    ctx.builder.wrap_i64_to_i32();
    ctx.builder.const_i32(((TLB_HIGH_SIZE - 1) << 3) as i32);
    ctx.builder.and_i32();
    let slot = ctx.builder.tee_new_local();

    ctx.builder
        .load_aligned_i64(unsafe { &raw const cpu::tlb_high_page } as u32);
    ctx.builder.get_local_i64(&page);
    ctx.builder.eq_i64();
    ctx.builder.free_local_i64(page);

    ctx.builder.get_local(&slot);
    ctx.builder
        .load_aligned_i64(unsafe { &raw const cpu::tlb_high_entry } as u32);
    ctx.builder.free_local(slot);
    ctx.builder.wrap_i64_to_i32();
    ctx.builder.tee_local(entry);

    // flags that must be clear (or set) for the fast path
    let user = if ctx.cpu.cpl3() { TLB_NO_USER } else { 0 };
    let mask = if for_writing {
        TLB_VALID | TLB_READONLY | TLB_HAS_CODE | user | crate::cpu::cpu::TLB_IN_MAPPED_RANGE
    }
    else {
        TLB_VALID | user | crate::cpu::cpu::TLB_IN_MAPPED_RANGE
    };
    dbg_assert!(mask & (TLB_GLOBAL | TLB_NOT_EXECUTABLE) == 0);
    ctx.builder.const_i32(mask);
    ctx.builder.and_i32();
    ctx.builder.const_i32(TLB_VALID);
    ctx.builder.eq_i32();
    ctx.builder.and_i32();

    if bits != 8 {
        ctx.builder.get_local_i64(address);
        ctx.builder.wrap_i64_to_i32();
        ctx.builder.const_i32(0xFFF);
        ctx.builder.and_i32();
        ctx.builder.const_i32(0x1000 - (bits / 8) as i32);
        ctx.builder.le_i32();
        ctx.builder.and_i32();
    }
}

/// pointer = (entry & ~0xFFF) ^ address
fn gen_pointer_from_entry(ctx: &mut JitContext, address: &WasmLocalI64, entry: &WasmLocal) {
    ctx.builder.get_local(entry);
    ctx.builder.const_i32(!0xFFF);
    ctx.builder.and_i32();
    ctx.builder.get_local_i64(address);
    ctx.builder.wrap_i64_to_i32();
    ctx.builder.xor_i32();
}

fn gen_load(ctx: &mut JitContext, bits: u32) {
    match bits {
        8 => ctx.builder.load_u8(0),
        16 => ctx.builder.load_unaligned_u16(0),
        32 => ctx.builder.load_unaligned_i32(0),
        _ => ctx.builder.load_unaligned_i64(0),
    }
}
fn gen_store(ctx: &mut JitContext, bits: u32) {
    match bits {
        8 => ctx.builder.store_u8(0),
        16 => ctx.builder.store_unaligned_u16(0),
        32 => ctx.builder.store_unaligned_i32(0),
        _ => ctx.builder.store_unaligned_i64(0),
    }
}

/// Read from memory, push the value (i32 zero-extended for up to 32 bits, i64 for 64 bits).
/// Exceptions leave the compiled code through exit_with_fault_label.
pub fn gen_safe_read(ctx: &mut JitContext, bits: u32, address: &WasmLocalI64) {
    let entry = ctx.builder.new_local();
    let cont = ctx.builder.block_void();
    gen_tlb_fast_path_check(ctx, bits, address, false, &entry);
    ctx.builder.br_if(cont);

    ctx.builder.get_local_i64(address);
    ctx.builder
        .const_i32((ctx.start_of_current_instruction & 0xFFF) as i32);
    ctx.builder.call_fn2_i64_i32_ret(match bits {
        8 => "safe_read8_slow_jit64",
        16 => "safe_read16_slow_jit64",
        32 => "safe_read32s_slow_jit64",
        _ => "safe_read64s_slow_jit64",
    });
    ctx.builder.tee_local(&entry);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();
    ctx.builder.br_if(ctx.exit_with_fault_label);
    ctx.builder.block_end();

    gen_pointer_from_entry(ctx, address, &entry);
    ctx.builder.free_local(entry);
    gen_load(ctx, bits);
}

/// Write a value to memory
pub fn gen_safe_write(ctx: &mut JitContext, bits: u32, address: &WasmLocalI64, value: &Val) {
    let entry = ctx.builder.new_local();
    let cont = ctx.builder.block_void();
    gen_tlb_fast_path_check(ctx, bits, address, true, &entry);
    ctx.builder.br_if(cont);

    gen_write_slow_path(ctx, bits, address, value);
    ctx.builder.tee_local(&entry);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();
    ctx.builder.br_if(ctx.exit_with_fault_label);
    ctx.builder.block_end();

    gen_pointer_from_entry(ctx, address, &entry);
    ctx.builder.free_local(entry);
    value.get(ctx);
    gen_store(ctx, bits);
}

fn gen_write_slow_path(ctx: &mut JitContext, bits: u32, address: &WasmLocalI64, value: &Val) {
    ctx.builder.get_local_i64(address);
    value.get(ctx);
    ctx.builder.const_i32(eip_and_wasm_table_index(ctx));
    match bits {
        8 => ctx.builder.call_fn3_i64_i32_i32_ret("safe_write8_slow_jit64"),
        16 => ctx.builder.call_fn3_i64_i32_i32_ret("safe_write16_slow_jit64"),
        32 => ctx.builder.call_fn3_i64_i32_i32_ret("safe_write32_slow_jit64"),
        _ => ctx.builder.call_fn3_i64_i64_i32_ret("safe_write64_slow_jit64"),
    }
}

/// Read-modify-write: f is called with the old value on the stack and must leave the new one
pub fn gen_safe_read_write(
    ctx: &mut JitContext,
    bits: u32,
    address: &WasmLocalI64,
    f: &dyn Fn(&mut JitContext),
) {
    let entry = ctx.builder.new_local();
    let cont = ctx.builder.block_void();
    gen_tlb_fast_path_check(ctx, bits, address, true, &entry);
    let can_use_fast_path = ctx.builder.tee_new_local();
    ctx.builder.br_if(cont);

    ctx.builder.get_local_i64(address);
    ctx.builder.const_i32(eip_and_wasm_table_index(ctx));
    ctx.builder.call_fn2_i64_i32_ret(match bits {
        8 => "safe_read_write8_slow_jit64",
        16 => "safe_read_write16_slow_jit64",
        32 => "safe_read_write32s_slow_jit64",
        _ => "safe_read_write64_slow_jit64",
    });
    ctx.builder.tee_local(&entry);
    ctx.builder.const_i32(1);
    ctx.builder.and_i32();
    ctx.builder.br_if(ctx.exit_with_fault_label);
    ctx.builder.block_end();

    gen_pointer_from_entry(ctx, address, &entry);
    ctx.builder.free_local(entry);
    let pointer = ctx.builder.tee_new_local();
    gen_load(ctx, bits);

    f(ctx);

    let value = set_new_val(ctx, bits);

    // the slow path for reading has done all checks, but writes across pages or to mapped
    // memory have to be done by the slow path for writing
    ctx.builder.get_local(&can_use_fast_path);
    ctx.builder.eqz_i32();
    ctx.builder.if_void();
    {
        gen_write_slow_path(ctx, bits, address, &value);
        ctx.builder.const_i32(1);
        ctx.builder.and_i32();
        ctx.builder.br_if(ctx.exit_with_fault_label);
    }
    ctx.builder.block_end();
    ctx.builder.free_local(can_use_fast_path);

    ctx.builder.get_local(&pointer);
    value.get(ctx);
    gen_store(ctx, bits);
    ctx.builder.free_local(pointer);
    value.free(ctx);
}

/// Compute the address of a memory operand into a new local
pub fn gen_modrm_address_local(ctx: &mut JitContext, m: &Modrm64) -> WasmLocalI64 {
    gen_modrm_address(ctx, m);
    ctx.builder.set_new_local_i64()
}

// Lazy flags (see cpu/arith.rs: add/sub use last_op1 and last_result, logical operations only
// last_result; 64-bit operations use the separate 64-bit slots)

pub fn opsize(bits: u32) -> i32 {
    match bits {
        8 => OPSIZE_8,
        16 => OPSIZE_16,
        32 => OPSIZE_32,
        _ => OPSIZE_64,
    }
}

fn gen_set_last_op1(ctx: &mut JitContext, bits: u32, value: &Val) {
    if bits == 64 {
        ctx.builder
            .const_i32(global_pointers::last_op1_64 as i32);
        value.get(ctx);
        ctx.builder.store_aligned_i64(0);
    }
    else {
        ctx.builder.const_i32(global_pointers::last_op1 as i32);
        value.get(ctx);
        ctx.builder.store_aligned_i32(0);
    }
}
fn gen_set_last_result(ctx: &mut JitContext, bits: u32, value: &Val) {
    if bits == 64 {
        ctx.builder
            .const_i32(global_pointers::last_result_64 as i32);
        value.get(ctx);
        ctx.builder.store_aligned_i64(0);
    }
    else {
        ctx.builder
            .const_i32(global_pointers::last_result as i32);
        value.get(ctx);
        ctx.builder.store_aligned_i32(0);
    }
}
fn gen_set_op_size_and_flags_changed(ctx: &mut JitContext, bits: u32, flags_changed: i32) {
    ctx.builder
        .const_i32(global_pointers::last_op_size as i32);
    ctx.builder.const_i32(opsize(bits));
    ctx.builder.store_aligned_i32(0);
    ctx.builder
        .const_i32(global_pointers::flags_changed as i32);
    ctx.builder.const_i32(flags_changed);
    ctx.builder.store_aligned_i32(0);
}
fn gen_clear_flags(ctx: &mut JitContext, clear: i32) {
    ctx.builder.const_i32(global_pointers::flags as i32);
    ctx.builder.load_fixed_i32(global_pointers::flags as u32);
    ctx.builder.const_i32(!clear);
    ctx.builder.and_i32();
    ctx.builder.store_aligned_i32(0);
}

/// flags for add/sub/cmp (op1 and result have the operand size)
pub fn gen_flags_arith(ctx: &mut JitContext, bits: u32, op1: &Val, result: &Val, is_sub: bool) {
    gen_set_last_op1(ctx, bits, op1);
    gen_set_last_result(ctx, bits, result);
    gen_set_op_size_and_flags_changed(ctx, bits, FLAGS_ALL | if is_sub { FLAG_SUB } else { 0 });
}

/// flags for and/or/xor/test
pub fn gen_flags_logic(ctx: &mut JitContext, bits: u32, result: &Val) {
    gen_set_last_result(ctx, bits, result);
    gen_set_op_size_and_flags_changed(
        ctx,
        bits,
        FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW & !FLAG_ADJUST,
    );
    gen_clear_flags(ctx, FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST);
}

// ---------------------------------------------------------------------------------------------
// Native instructions

/// An operand of a natively compiled instruction
pub enum Opnd {
    Reg(u32),
    Mem(Modrm64),
    Imm(i64),
}

pub const OP_ADD: u32 = 0;
pub const OP_OR: u32 = 1;
pub const OP_AND: u32 = 4;
pub const OP_SUB: u32 = 5;
pub const OP_XOR: u32 = 6;
pub const OP_CMP: u32 = 7;
pub const OP_TEST: u32 = 8;
pub const OP_MOV: u32 = 9;

fn mask_for(bits: u32) -> i32 {
    match bits {
        8 => 0xFF,
        16 => 0xFFFF,
        _ => -1,
    }
}

fn gen_const(ctx: &mut JitContext, bits: u32, value: i64) {
    if bits == 64 {
        ctx.builder.const_i64(value);
    }
    else {
        ctx.builder.const_i32(value as i32 & mask_for(bits));
    }
}

/// Push the value of a source operand
fn gen_get_operand(ctx: &mut JitContext, bits: u32, src: &Opnd) {
    match src {
        Opnd::Reg(r) => gen_get_reg(ctx, bits, *r),
        Opnd::Imm(i) => gen_const(ctx, bits, *i),
        Opnd::Mem(m) => {
            let address = gen_modrm_address_local(ctx, m);
            gen_safe_read(ctx, bits, &address);
            ctx.builder.free_local_i64(address);
        },
    }
}

/// result = op1 <op> op2 (both on the stack), masked to the operand size
fn gen_binop(ctx: &mut JitContext, op: u32, bits: u32) {
    if bits == 64 {
        match op {
            OP_ADD => ctx.builder.add_i64(),
            OP_OR => ctx.builder.or_i64(),
            OP_AND | OP_TEST => ctx.builder.and_i64(),
            OP_SUB | OP_CMP => ctx.builder.sub_i64(),
            OP_XOR => ctx.builder.xor_i64(),
            _ => dbg_assert!(false),
        }
    }
    else {
        match op {
            OP_ADD => ctx.builder.add_i32(),
            OP_OR => ctx.builder.or_i32(),
            OP_AND | OP_TEST => ctx.builder.and_i32(),
            OP_SUB | OP_CMP => ctx.builder.sub_i32(),
            OP_XOR => ctx.builder.xor_i32(),
            _ => dbg_assert!(false),
        }
        if bits < 32 && (op == OP_ADD || op == OP_SUB || op == OP_CMP) {
            ctx.builder.const_i32(mask_for(bits));
            ctx.builder.and_i32();
        }
    }
}

/// Compute op1 <op> src, set the lazy flags, leave the result in a new local
fn gen_alu_value(ctx: &mut JitContext, op: u32, bits: u32, op1: &Val, src: &Val) -> Val {
    op1.get(ctx);
    src.get(ctx);
    gen_binop(ctx, op, bits);
    let result = set_new_val(ctx, bits);
    match op {
        OP_ADD => gen_flags_arith(ctx, bits, op1, &result, false),
        OP_SUB | OP_CMP => gen_flags_arith(ctx, bits, op1, &result, true),
        _ => gen_flags_logic(ctx, bits, &result),
    }
    result
}

/// add/or/and/sub/xor/cmp/test/mov dst, src
pub fn gen_alu(ctx: &mut JitContext, op: u32, bits: u32, dst: Opnd, src: Opnd) {
    // read the source first (a memory source may fault before anything is modified)
    let src_is_mem = match src {
        Opnd::Mem(_) => true,
        _ => false,
    };
    dbg_assert!(!src_is_mem || !matches!(dst, Opnd::Mem(_)));
    gen_get_operand(ctx, bits, &src);
    let src = set_new_val(ctx, bits);

    match dst {
        Opnd::Reg(r) => {
            if op == OP_MOV {
                gen_set_reg(ctx, bits, r, &src);
            }
            else {
                gen_get_reg(ctx, bits, r);
                let op1 = set_new_val(ctx, bits);
                let result = gen_alu_value(ctx, op, bits, &op1, &src);
                if op != OP_CMP && op != OP_TEST {
                    gen_set_reg(ctx, bits, r, &result);
                }
                result.free(ctx);
                op1.free(ctx);
            }
        },
        Opnd::Mem(m) => {
            let address = gen_modrm_address_local(ctx, &m);
            if op == OP_MOV {
                gen_safe_write(ctx, bits, &address, &src);
            }
            else if op == OP_CMP || op == OP_TEST {
                gen_safe_read(ctx, bits, &address);
                let op1 = set_new_val(ctx, bits);
                let result = gen_alu_value(ctx, op, bits, &op1, &src);
                result.free(ctx);
                op1.free(ctx);
            }
            else {
                let src_ref = &src;
                gen_safe_read_write(ctx, bits, &address, &|ctx| {
                    let op1 = set_new_val(ctx, bits);
                    let result = gen_alu_value(ctx, op, bits, &op1, src_ref);
                    result.get(ctx);
                    result.free(ctx);
                    op1.free(ctx);
                });
            }
            ctx.builder.free_local_i64(address);
        },
        Opnd::Imm(_) => dbg_assert!(false),
    }
    src.free(ctx);
}

/// movzx/movsx/movsxd r, r/m: the source has src_bits, the destination dst_bits
pub fn gen_movx(ctx: &mut JitContext, signed: bool, src_bits: u32, dst_bits: u32, r: u32, src: Opnd) {
    gen_get_operand(ctx, src_bits, &src);
    if signed && src_bits < 32 {
        let shift = 32 - src_bits as i32;
        ctx.builder.const_i32(shift);
        ctx.builder.shl_i32();
        ctx.builder.const_i32(shift);
        ctx.builder.shr_s_i32();
    }
    if dst_bits == 64 {
        if signed {
            ctx.builder.extend_signed_i32_to_i64();
        }
        else {
            ctx.builder.extend_unsigned_i32_to_i64();
        }
    }
    else if dst_bits == 16 {
        ctx.builder.const_i32(0xFFFF);
        ctx.builder.and_i32();
    }
    gen_set_reg_from_stack(ctx, dst_bits, r);
}

/// inc/dec r/m: cf is preserved
pub fn gen_incdec(ctx: &mut JitContext, is_dec: bool, bits: u32, dst: Opnd) {
    // materialise cf into flags before the lazy state is overwritten
    ctx.builder.call_fn0("jit64_save_cf");
    let one = set_new_val_const(ctx, bits, 1);
    let flags_changed =
        FLAGS_ALL & !FLAG_CARRY | if is_dec { FLAG_SUB } else { 0 };
    let op = if is_dec { OP_SUB } else { OP_ADD };
    let compute = |ctx: &mut JitContext, op1: &Val| -> Val {
        op1.get(ctx);
        one.get(ctx);
        gen_binop(ctx, op, bits);
        let result = set_new_val(ctx, bits);
        gen_set_last_op1(ctx, bits, op1);
        gen_set_last_result(ctx, bits, &result);
        gen_set_op_size_and_flags_changed(ctx, bits, flags_changed);
        result
    };
    match dst {
        Opnd::Reg(r) => {
            gen_get_reg(ctx, bits, r);
            let op1 = set_new_val(ctx, bits);
            let result = compute(ctx, &op1);
            gen_set_reg(ctx, bits, r, &result);
            result.free(ctx);
            op1.free(ctx);
        },
        Opnd::Mem(m) => {
            let address = gen_modrm_address_local(ctx, &m);
            gen_safe_read_write(ctx, bits, &address, &|ctx| {
                let op1 = set_new_val(ctx, bits);
                let result = compute(ctx, &op1);
                result.get(ctx);
                result.free(ctx);
                op1.free(ctx);
            });
            ctx.builder.free_local_i64(address);
        },
        Opnd::Imm(_) => dbg_assert!(false),
    }
    one.free(ctx);
}

fn set_new_val_const(ctx: &mut JitContext, bits: u32, value: i64) -> Val {
    gen_const(ctx, bits, value);
    set_new_val(ctx, bits)
}

/// push (64-bit operand size): the store happens before rsp is updated
pub fn gen_push64(ctx: &mut JitContext, src: Opnd) {
    gen_get_operand(ctx, 64, &src);
    let value = set_new_val(ctx, 64);
    gen_get_reg(ctx, 64, crate::regs::ESP);
    ctx.builder.const_i64(8);
    ctx.builder.sub_i64();
    let new_rsp = ctx.builder.set_new_local_i64();
    gen_safe_write(ctx, 64, &new_rsp, &value);
    let new_rsp = Val::I64(new_rsp);
    gen_set_reg(ctx, 64, crate::regs::ESP, &new_rsp);
    new_rsp.free(ctx);
    value.free(ctx);
}

/// pop r64
pub fn gen_pop64(ctx: &mut JitContext, r: u32) {
    gen_get_reg(ctx, 64, crate::regs::ESP);
    let rsp = ctx.builder.set_new_local_i64();
    gen_safe_read(ctx, 64, &rsp);
    let value = set_new_val(ctx, 64);
    ctx.builder
        .const_i32(global_pointers::get_reg64_offset(crate::regs::ESP) as i32);
    ctx.builder.get_local_i64(&rsp);
    ctx.builder.const_i64(8);
    ctx.builder.add_i64();
    ctx.builder.store_aligned_i64(0);
    ctx.builder.free_local_i64(rsp);
    gen_set_reg(ctx, 64, r, &value);
    value.free(ctx);
}

/// ret (near, 64-bit): the block glue continues at the new instruction pointer
pub fn gen_ret64(ctx: &mut JitContext, imm16: u32) {
    gen_get_reg(ctx, 64, crate::regs::ESP);
    let rsp = ctx.builder.set_new_local_i64();
    gen_safe_read(ctx, 64, &rsp);
    let target = ctx.builder.set_new_local_i64();
    ctx.builder
        .const_i32(global_pointers::get_reg64_offset(crate::regs::ESP) as i32);
    ctx.builder.get_local_i64(&rsp);
    ctx.builder.const_i64(8 + imm16 as i64);
    ctx.builder.add_i64();
    ctx.builder.store_aligned_i64(0);
    ctx.builder.free_local_i64(rsp);
    ctx.builder
        .const_i32(global_pointers::instruction_pointer as i32);
    ctx.builder.get_local_i64(&target);
    ctx.builder.store_aligned_i64(0);
    ctx.builder.free_local_i64(target);
}

#[no_mangle]
pub unsafe fn jit64_save_cf() {
    let cf = crate::cpu::misc_instr::getcf();
    *global_pointers::flags = *global_pointers::flags & !FLAG_CARRY | cf as i32;
}

