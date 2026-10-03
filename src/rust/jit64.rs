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
