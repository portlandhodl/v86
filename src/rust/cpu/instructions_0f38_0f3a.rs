#![allow(non_snake_case)]

// SSSE3, SSE4.1 and SSE4.2: the instructions of the three-byte opcode maps 0F 38 xx and 0F 3A xx
// (see the map entries in gen/x86_table.js). Re-exported by instructions_0f, where the generated
// tables look for them. Instruction names: instr_[66|F2]0F38xx / instr_[66]0F3Axx; the forms
// without prefix operate on mmx registers, the 66 forms on xmm registers.

use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::paging::OrPageFault;

// ---------------------------------------------------------------------------------------------
// Helpers

/// Saturate to i16
fn sat16(x: i32) -> i16 { x.clamp(i16::MIN as i32, i16::MAX as i32) as i16 }

/// Saturate to u16
fn satu16(x: i32) -> u16 { x.clamp(0, u16::MAX as i32) as u16 }

unsafe fn mmx_bytes(x: u64) -> [u8; 8] { x.to_le_bytes() }
unsafe fn mmx_words(x: u64) -> [i16; 4] { std::mem::transmute(x) }
unsafe fn mmx_dwords(x: u64) -> [i32; 2] { std::mem::transmute(x) }

// x86 NaN semantics for the floating point instructions below (wasm's differ): a NaN operand is
// returned quieted, the first operand's if both are NaN; invalid operations (inf - inf, 0 * inf)
// return the default NaN (negative, quiet).
const F32_QUIET: u32 = 0x0040_0000;
const F64_QUIET: u64 = 0x0008_0000_0000_0000;
const F32_DEFAULT_NAN: u32 = 0xFFC0_0000;

fn quiet_f32(x: f32) -> f32 { f32::from_bits(x.to_bits() | F32_QUIET) }
fn quiet_f64(x: f64) -> f64 { f64::from_bits(x.to_bits() | F64_QUIET) }

fn x86_f32_op(a: f32, b: f32, op: fn(f32, f32) -> f32) -> f32 {
    if a.is_nan() {
        quiet_f32(a)
    }
    else if b.is_nan() {
        quiet_f32(b)
    }
    else {
        let r = op(a, b);
        if r.is_nan() {
            f32::from_bits(F32_DEFAULT_NAN)
        }
        else {
            r
        }
    }
}
fn x86_f64_op(a: f64, b: f64, op: fn(f64, f64) -> f64) -> f64 {
    if a.is_nan() {
        quiet_f64(a)
    }
    else if b.is_nan() {
        quiet_f64(b)
    }
    else {
        let r = op(a, b);
        if r.is_nan() {
            f64::from_bits(0xFFF8_0000_0000_0000)
        }
        else {
            r
        }
    }
}
fn add_f32(a: f32, b: f32) -> f32 { x86_f32_op(a, b, |a, b| a + b) }
fn mul_f32(a: f32, b: f32) -> f32 { x86_f32_op(a, b, |a, b| a * b) }
fn add_f64(a: f64, b: f64) -> f64 { x86_f64_op(a, b, |a, b| a + b) }
fn mul_f64(a: f64, b: f64) -> f64 { x86_f64_op(a, b, |a, b| a * b) }

// ---------------------------------------------------------------------------------------------
// SSSE3 (0F 38 00-0B, 1C-1E and 0F 3A 0F), mmx and xmm forms

macro_rules! ssse3_pair {
    ($name:ident, $name_reg:ident, $name_mem:ident, $name66:ident, $name66_reg:ident, $name66_mem:ident,
     $mmx:expr, $xmm:expr) => {
        pub unsafe fn $name(source: u64, r: i32) {
            let f: unsafe fn(u64, u64) -> u64 = $mmx;
            write_mmx_reg64(r, f(read_mmx64s(r), source));
            transition_fpu_to_mmx();
        }
        #[no_mangle]
        pub unsafe fn $name_reg(r1: i32, r2: i32) { $name(read_mmx64s(r1), r2) }
        #[no_mangle]
        pub unsafe fn $name_mem(addr: u64, r: i32) {
            $name(return_on_pagefault!(safe_read64s(addr)), r)
        }

        pub unsafe fn $name66(source: reg128, r: i32) {
            let f: unsafe fn(reg128, reg128) -> reg128 = $xmm;
            write_xmm_reg128(r, f(read_xmm128s(r), source));
        }
        #[no_mangle]
        pub unsafe fn $name66_reg(r1: i32, r2: i32) { $name66(read_xmm128s(r1), r2) }
        #[no_mangle]
        pub unsafe fn $name66_mem(addr: u64, r: i32) {
            $name66(return_on_pagefault!(safe_read128s(addr)), r)
        }
    };
}

// pshufb
unsafe fn pshufb64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_bytes(d), mmx_bytes(s));
    let mut r = [0u8; 8];
    for i in 0..8 {
        r[i] = if s[i] & 0x80 != 0 { 0 } else { d[(s[i] & 7) as usize] };
    }
    u64::from_le_bytes(r)
}
unsafe fn pshufb128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { u8: [0; 16] };
    for i in 0..16 {
        r.u8[i] = if s.u8[i] & 0x80 != 0 { 0 } else { d.u8[(s.u8[i] & 15) as usize] };
    }
    r
}
ssse3_pair!(
    instr_0F3800,
    instr_0F3800_reg,
    instr_0F3800_mem,
    instr_660F3800,
    instr_660F3800_reg,
    instr_660F3800_mem,
    pshufb64,
    pshufb128
);

// horizontal add/subtract: the pairs of the destination, then the pairs of the source
unsafe fn hop_words64(d: u64, s: u64, f: fn(i16, i16) -> i16) -> u64 {
    let (d, s) = (mmx_words(d), mmx_words(s));
    std::mem::transmute([f(d[0], d[1]), f(d[2], d[3]), f(s[0], s[1]), f(s[2], s[3])])
}
unsafe fn hop_words128(d: reg128, s: reg128, f: fn(i16, i16) -> i16) -> reg128 {
    let mut r = reg128 { i16: [0; 8] };
    for i in 0..4 {
        r.i16[i] = f(d.i16[2 * i], d.i16[2 * i + 1]);
        r.i16[i + 4] = f(s.i16[2 * i], s.i16[2 * i + 1]);
    }
    r
}
unsafe fn hop_dwords64(d: u64, s: u64, f: fn(i32, i32) -> i32) -> u64 {
    let (d, s) = (mmx_dwords(d), mmx_dwords(s));
    std::mem::transmute([f(d[0], d[1]), f(s[0], s[1])])
}
unsafe fn hop_dwords128(d: reg128, s: reg128, f: fn(i32, i32) -> i32) -> reg128 {
    reg128 {
        i32: [
            f(d.i32[0], d.i32[1]),
            f(d.i32[2], d.i32[3]),
            f(s.i32[0], s.i32[1]),
            f(s.i32[2], s.i32[3]),
        ],
    }
}
fn addw(a: i16, b: i16) -> i16 { a.wrapping_add(b) }
fn subw(a: i16, b: i16) -> i16 { a.wrapping_sub(b) }
fn addsw(a: i16, b: i16) -> i16 { a.saturating_add(b) }
fn subsw(a: i16, b: i16) -> i16 { a.saturating_sub(b) }
fn addd(a: i32, b: i32) -> i32 { a.wrapping_add(b) }
fn subd(a: i32, b: i32) -> i32 { a.wrapping_sub(b) }

ssse3_pair!(
    instr_0F3801,
    instr_0F3801_reg,
    instr_0F3801_mem,
    instr_660F3801,
    instr_660F3801_reg,
    instr_660F3801_mem,
    |d, s| hop_words64(d, s, addw),
    |d, s| hop_words128(d, s, addw)
);
ssse3_pair!(
    instr_0F3802,
    instr_0F3802_reg,
    instr_0F3802_mem,
    instr_660F3802,
    instr_660F3802_reg,
    instr_660F3802_mem,
    |d, s| hop_dwords64(d, s, addd),
    |d, s| hop_dwords128(d, s, addd)
);
ssse3_pair!(
    instr_0F3803,
    instr_0F3803_reg,
    instr_0F3803_mem,
    instr_660F3803,
    instr_660F3803_reg,
    instr_660F3803_mem,
    |d, s| hop_words64(d, s, addsw),
    |d, s| hop_words128(d, s, addsw)
);
ssse3_pair!(
    instr_0F3805,
    instr_0F3805_reg,
    instr_0F3805_mem,
    instr_660F3805,
    instr_660F3805_reg,
    instr_660F3805_mem,
    |d, s| hop_words64(d, s, subw),
    |d, s| hop_words128(d, s, subw)
);
ssse3_pair!(
    instr_0F3806,
    instr_0F3806_reg,
    instr_0F3806_mem,
    instr_660F3806,
    instr_660F3806_reg,
    instr_660F3806_mem,
    |d, s| hop_dwords64(d, s, subd),
    |d, s| hop_dwords128(d, s, subd)
);
ssse3_pair!(
    instr_0F3807,
    instr_0F3807_reg,
    instr_0F3807_mem,
    instr_660F3807,
    instr_660F3807_reg,
    instr_660F3807_mem,
    |d, s| hop_words64(d, s, subsw),
    |d, s| hop_words128(d, s, subsw)
);

// pmaddubsw: unsigned bytes of the destination times signed bytes of the source, adjacent
// products added with signed saturation
fn maddubs(d0: u8, s0: u8, d1: u8, s1: u8) -> i16 {
    sat16(d0 as i32 * s0 as i8 as i32 + d1 as i32 * s1 as i8 as i32)
}
unsafe fn pmaddubsw64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_bytes(d), mmx_bytes(s));
    let mut r = [0i16; 4];
    for i in 0..4 {
        r[i] = maddubs(d[2 * i], s[2 * i], d[2 * i + 1], s[2 * i + 1]);
    }
    std::mem::transmute(r)
}
unsafe fn pmaddubsw128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { i16: [0; 8] };
    for i in 0..8 {
        r.i16[i] = maddubs(d.u8[2 * i], s.u8[2 * i], d.u8[2 * i + 1], s.u8[2 * i + 1]);
    }
    r
}
ssse3_pair!(
    instr_0F3804,
    instr_0F3804_reg,
    instr_0F3804_mem,
    instr_660F3804,
    instr_660F3804_reg,
    instr_660F3804_mem,
    pmaddubsw64,
    pmaddubsw128
);

// psignb/w/d: negate, zero or keep the destination by the sign of the source
macro_rules! psign {
    ($t:ty, $d:expr, $s:expr) => {{
        let (d, s): ($t, $t) = ($d, $s);
        if s < 0 {
            d.wrapping_neg()
        }
        else if s == 0 {
            0
        }
        else {
            d
        }
    }};
}
unsafe fn psignb64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_bytes(d), mmx_bytes(s));
    let mut r = [0u8; 8];
    for i in 0..8 {
        r[i] = psign!(i8, d[i] as i8, s[i] as i8) as u8;
    }
    u64::from_le_bytes(r)
}
unsafe fn psignb128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { i8: [0; 16] };
    for i in 0..16 {
        r.i8[i] = psign!(i8, d.i8[i], s.i8[i]);
    }
    r
}
unsafe fn psignw64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_words(d), mmx_words(s));
    let mut r = [0i16; 4];
    for i in 0..4 {
        r[i] = psign!(i16, d[i], s[i]);
    }
    std::mem::transmute(r)
}
unsafe fn psignw128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { i16: [0; 8] };
    for i in 0..8 {
        r.i16[i] = psign!(i16, d.i16[i], s.i16[i]);
    }
    r
}
unsafe fn psignd64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_dwords(d), mmx_dwords(s));
    std::mem::transmute([psign!(i32, d[0], s[0]), psign!(i32, d[1], s[1])])
}
unsafe fn psignd128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { i32: [0; 4] };
    for i in 0..4 {
        r.i32[i] = psign!(i32, d.i32[i], s.i32[i]);
    }
    r
}
ssse3_pair!(
    instr_0F3808,
    instr_0F3808_reg,
    instr_0F3808_mem,
    instr_660F3808,
    instr_660F3808_reg,
    instr_660F3808_mem,
    psignb64,
    psignb128
);
ssse3_pair!(
    instr_0F3809,
    instr_0F3809_reg,
    instr_0F3809_mem,
    instr_660F3809,
    instr_660F3809_reg,
    instr_660F3809_mem,
    psignw64,
    psignw128
);
ssse3_pair!(
    instr_0F380A,
    instr_0F380A_reg,
    instr_0F380A_mem,
    instr_660F380A,
    instr_660F380A_reg,
    instr_660F380A_mem,
    psignd64,
    psignd128
);

// pmulhrsw: rounded high half of the 16x16 products
fn mulhrs(a: i16, b: i16) -> i16 { ((((a as i32 * b as i32) >> 14) + 1) >> 1) as i16 }
unsafe fn pmulhrsw64(d: u64, s: u64) -> u64 {
    let (d, s) = (mmx_words(d), mmx_words(s));
    std::mem::transmute([
        mulhrs(d[0], s[0]),
        mulhrs(d[1], s[1]),
        mulhrs(d[2], s[2]),
        mulhrs(d[3], s[3]),
    ])
}
unsafe fn pmulhrsw128(d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { i16: [0; 8] };
    for i in 0..8 {
        r.i16[i] = mulhrs(d.i16[i], s.i16[i]);
    }
    r
}
ssse3_pair!(
    instr_0F380B,
    instr_0F380B_reg,
    instr_0F380B_mem,
    instr_660F380B,
    instr_660F380B_reg,
    instr_660F380B_mem,
    pmulhrsw64,
    pmulhrsw128
);

// pabsb/w/d: absolute value of the source (the destination is only written)
unsafe fn pabsb64(_d: u64, s: u64) -> u64 {
    let s = mmx_bytes(s);
    let mut r = [0u8; 8];
    for i in 0..8 {
        r[i] = (s[i] as i8).unsigned_abs();
    }
    u64::from_le_bytes(r)
}
unsafe fn pabsb128(_d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { u8: [0; 16] };
    for i in 0..16 {
        r.u8[i] = s.i8[i].unsigned_abs();
    }
    r
}
unsafe fn pabsw64(_d: u64, s: u64) -> u64 {
    let s = mmx_words(s);
    std::mem::transmute([
        s[0].unsigned_abs(),
        s[1].unsigned_abs(),
        s[2].unsigned_abs(),
        s[3].unsigned_abs(),
    ])
}
unsafe fn pabsw128(_d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { u16: [0; 8] };
    for i in 0..8 {
        r.u16[i] = s.i16[i].unsigned_abs();
    }
    r
}
unsafe fn pabsd64(_d: u64, s: u64) -> u64 {
    let s = mmx_dwords(s);
    std::mem::transmute([s[0].unsigned_abs(), s[1].unsigned_abs()])
}
unsafe fn pabsd128(_d: reg128, s: reg128) -> reg128 {
    let mut r = reg128 { u32: [0; 4] };
    for i in 0..4 {
        r.u32[i] = s.i32[i].unsigned_abs();
    }
    r
}
ssse3_pair!(
    instr_0F381C,
    instr_0F381C_reg,
    instr_0F381C_mem,
    instr_660F381C,
    instr_660F381C_reg,
    instr_660F381C_mem,
    pabsb64,
    pabsb128
);
ssse3_pair!(
    instr_0F381D,
    instr_0F381D_reg,
    instr_0F381D_mem,
    instr_660F381D,
    instr_660F381D_reg,
    instr_660F381D_mem,
    pabsw64,
    pabsw128
);
ssse3_pair!(
    instr_0F381E,
    instr_0F381E_reg,
    instr_0F381E_mem,
    instr_660F381E,
    instr_660F381E_reg,
    instr_660F381E_mem,
    pabsd64,
    pabsd128
);

// palignr: the concatenation destination:source shifted right by imm8 bytes
pub unsafe fn instr_0F3A0F(source: u64, r: i32, imm8: i32) {
    let destination = read_mmx64s(r);
    let shift = (imm8 & 0xFF) as u32;
    let concat = (destination as u128) << 64 | source as u128;
    let result = if shift >= 16 { 0 } else { (concat >> (shift * 8)) as u64 };
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F3A0F_reg(r1: i32, r2: i32, imm: i32) {
    instr_0F3A0F(read_mmx64s(r1), r2, imm)
}
#[no_mangle]
pub unsafe fn instr_0F3A0F_mem(addr: u64, r: i32, imm: i32) {
    instr_0F3A0F(return_on_pagefault!(safe_read64s(addr)), r, imm)
}
pub unsafe fn instr_660F3A0F(source: reg128, r: i32, imm8: i32) {
    let destination = read_xmm128s(r);
    let shift = (imm8 & 0xFF) as usize;
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(&source.u8);
    bytes[16..].copy_from_slice(&destination.u8);
    let mut result = reg128 { u8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = if shift + i < 32 { bytes[shift + i] } else { 0 };
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F3A0F_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0F(read_xmm128s(r1), r2, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A0F_mem(addr: u64, r: i32, imm: i32) {
    instr_660F3A0F(return_on_pagefault!(safe_read128s(addr)), r, imm)
}

// ---------------------------------------------------------------------------------------------
// SSE4.1 and SSE4.2, xmm forms (66 prefix)

macro_rules! xmm_op {
    ($name:ident, $name_reg:ident, $name_mem:ident, $f:expr) => {
        pub unsafe fn $name(source: reg128, r: i32) {
            let f: unsafe fn(reg128, reg128) -> reg128 = $f;
            write_xmm_reg128(r, f(read_xmm128s(r), source));
        }
        #[no_mangle]
        pub unsafe fn $name_reg(r1: i32, r2: i32) { $name(read_xmm128s(r1), r2) }
        #[no_mangle]
        pub unsafe fn $name_mem(addr: u64, r: i32) {
            $name(return_on_pagefault!(safe_read128s(addr)), r)
        }
    };
}
macro_rules! xmm_op_imm {
    ($name:ident, $name_reg:ident, $name_mem:ident, $f:expr) => {
        pub unsafe fn $name(source: reg128, r: i32, imm8: i32) {
            let f: unsafe fn(reg128, reg128, i32) -> reg128 = $f;
            write_xmm_reg128(r, f(read_xmm128s(r), source, imm8 & 0xFF));
        }
        #[no_mangle]
        pub unsafe fn $name_reg(r1: i32, r2: i32, imm: i32) { $name(read_xmm128s(r1), r2, imm) }
        #[no_mangle]
        pub unsafe fn $name_mem(addr: u64, r: i32, imm: i32) {
            $name(return_on_pagefault!(safe_read128s(addr)), r, imm)
        }
    };
}

// pblendvb, blendvps, blendvpd: select by the sign bits of xmm0
xmm_op!(
    instr_660F3810,
    instr_660F3810_reg,
    instr_660F3810_mem,
    |d, s| {
        let mask = read_xmm128s(0);
        let mut r = d;
        for i in 0..16 {
            if mask.i8[i] < 0 {
                r.u8[i] = s.u8[i];
            }
        }
        r
    }
);
xmm_op!(
    instr_660F3814,
    instr_660F3814_reg,
    instr_660F3814_mem,
    |d, s| {
        let mask = read_xmm128s(0);
        let mut r = d;
        for i in 0..4 {
            if mask.i32[i] < 0 {
                r.u32[i] = s.u32[i];
            }
        }
        r
    }
);
xmm_op!(
    instr_660F3815,
    instr_660F3815_reg,
    instr_660F3815_mem,
    |d, s| {
        let mask = read_xmm128s(0);
        let mut r = d;
        for i in 0..2 {
            if mask.i64[i] < 0 {
                r.u64[i] = s.u64[i];
            }
        }
        r
    }
);

// ptest: zf = (source & destination) == 0, cf = (source & !destination) == 0
pub unsafe fn instr_660F3817(source: reg128, r: i32) {
    let destination = read_xmm128s(r);
    let and = source.u64[0] & destination.u64[0] | source.u64[1] & destination.u64[1];
    let andn = source.u64[0] & !destination.u64[0] | source.u64[1] & !destination.u64[1];
    *flags_changed = 0;
    *flags = *flags & !FLAGS_ALL
        | if and == 0 { FLAG_ZERO } else { 0 }
        | if andn == 0 { FLAG_CARRY } else { 0 };
}
#[no_mangle]
pub unsafe fn instr_660F3817_reg(r1: i32, r2: i32) { instr_660F3817(read_xmm128s(r1), r2) }
#[no_mangle]
pub unsafe fn instr_660F3817_mem(addr: u64, r: i32) {
    instr_660F3817(return_on_pagefault!(safe_read128s(addr)), r)
}

// pmovsx/pmovzx: the low elements of the source (an m64, m32 or m16 for the memory forms),
// sign- or zero-extended
macro_rules! pmovx {
    ($name:ident, $name_reg:ident, $name_mem:ident, $read:expr, $f:expr) => {
        pub unsafe fn $name(source: u64, r: i32) {
            let f: unsafe fn(u64) -> reg128 = $f;
            write_xmm_reg128(r, f(source));
        }
        #[no_mangle]
        pub unsafe fn $name_reg(r1: i32, r2: i32) { $name(read_xmm64s(r1), r2) }
        #[no_mangle]
        pub unsafe fn $name_mem(addr: u64, r: i32) {
            let read: unsafe fn(u64) -> OrPageFault<u64> = $read;
            $name(return_on_pagefault!(read(addr)), r)
        }
    };
}
unsafe fn read_m64(addr: u64) -> OrPageFault<u64> { safe_read64s(addr) }
unsafe fn read_m32(addr: u64) -> OrPageFault<u64> { Ok(safe_read32s(addr)? as u32 as u64) }
unsafe fn read_m16(addr: u64) -> OrPageFault<u64> { Ok(safe_read16(addr)? as u16 as u64) }

pmovx!(
    instr_660F3820,
    instr_660F3820_reg,
    instr_660F3820_mem,
    read_m64,
    |s| {
        let b = s.to_le_bytes();
        let mut r = reg128 { i16: [0; 8] };
        for i in 0..8 {
            r.i16[i] = b[i] as i8 as i16;
        }
        r
    }
);
pmovx!(
    instr_660F3821,
    instr_660F3821_reg,
    instr_660F3821_mem,
    read_m32,
    |s| {
        let b = s.to_le_bytes();
        let mut r = reg128 { i32: [0; 4] };
        for i in 0..4 {
            r.i32[i] = b[i] as i8 as i32;
        }
        r
    }
);
pmovx!(
    instr_660F3822,
    instr_660F3822_reg,
    instr_660F3822_mem,
    read_m16,
    |s| {
        let b = s.to_le_bytes();
        reg128 {
            i64: [b[0] as i8 as i64, b[1] as i8 as i64],
        }
    }
);
pmovx!(
    instr_660F3823,
    instr_660F3823_reg,
    instr_660F3823_mem,
    read_m64,
    |s| {
        let w = mmx_words(s);
        reg128 {
            i32: [w[0] as i32, w[1] as i32, w[2] as i32, w[3] as i32],
        }
    }
);
pmovx!(
    instr_660F3824,
    instr_660F3824_reg,
    instr_660F3824_mem,
    read_m32,
    |s| {
        let w = mmx_words(s);
        reg128 {
            i64: [w[0] as i64, w[1] as i64],
        }
    }
);
pmovx!(
    instr_660F3825,
    instr_660F3825_reg,
    instr_660F3825_mem,
    read_m64,
    |s| {
        let d = mmx_dwords(s);
        reg128 {
            i64: [d[0] as i64, d[1] as i64],
        }
    }
);
pmovx!(
    instr_660F3830,
    instr_660F3830_reg,
    instr_660F3830_mem,
    read_m64,
    |s| {
        let b = s.to_le_bytes();
        let mut r = reg128 { u16: [0; 8] };
        for i in 0..8 {
            r.u16[i] = b[i] as u16;
        }
        r
    }
);
pmovx!(
    instr_660F3831,
    instr_660F3831_reg,
    instr_660F3831_mem,
    read_m32,
    |s| {
        let b = s.to_le_bytes();
        reg128 {
            u32: [b[0] as u32, b[1] as u32, b[2] as u32, b[3] as u32],
        }
    }
);
pmovx!(
    instr_660F3832,
    instr_660F3832_reg,
    instr_660F3832_mem,
    read_m16,
    |s| {
        let b = s.to_le_bytes();
        reg128 {
            u64: [b[0] as u64, b[1] as u64],
        }
    }
);
pmovx!(
    instr_660F3833,
    instr_660F3833_reg,
    instr_660F3833_mem,
    read_m64,
    |s| {
        let w = mmx_words(s);
        reg128 {
            u32: [
                w[0] as u16 as u32,
                w[1] as u16 as u32,
                w[2] as u16 as u32,
                w[3] as u16 as u32,
            ],
        }
    }
);
pmovx!(
    instr_660F3834,
    instr_660F3834_reg,
    instr_660F3834_mem,
    read_m32,
    |s| {
        let w = mmx_words(s);
        reg128 {
            u64: [w[0] as u16 as u64, w[1] as u16 as u64],
        }
    }
);
pmovx!(
    instr_660F3835,
    instr_660F3835_reg,
    instr_660F3835_mem,
    read_m64,
    |s| {
        let d = mmx_dwords(s);
        reg128 {
            u64: [d[0] as u32 as u64, d[1] as u32 as u64],
        }
    }
);

// pmuldq: signed products of the even dwords
xmm_op!(
    instr_660F3828,
    instr_660F3828_reg,
    instr_660F3828_mem,
    |d, s| {
        reg128 {
            i64: [
                d.i32[0] as i64 * s.i32[0] as i64,
                d.i32[2] as i64 * s.i32[2] as i64,
            ],
        }
    }
);
// pcmpeqq
xmm_op!(
    instr_660F3829,
    instr_660F3829_reg,
    instr_660F3829_mem,
    |d, s| {
        reg128 {
            i64: [
                -((d.u64[0] == s.u64[0]) as i64),
                -((d.u64[1] == s.u64[1]) as i64),
            ],
        }
    }
);

// movntdqa xmm, m128 (memory only)
#[no_mangle]
pub unsafe fn instr_660F382A_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F382A_mem(addr: u64, r: i32) {
    let data = return_on_pagefault!(safe_read128s(addr));
    write_xmm_reg128(r, data);
}

// packusdw: signed dwords to unsigned words with saturation, destination first
xmm_op!(
    instr_660F382B,
    instr_660F382B_reg,
    instr_660F382B_mem,
    |d, s| {
        let mut r = reg128 { u16: [0; 8] };
        for i in 0..4 {
            r.u16[i] = satu16(d.i32[i]);
            r.u16[i + 4] = satu16(s.i32[i]);
        }
        r
    }
);

// pcmpgtq (sse4.2)
xmm_op!(
    instr_660F3837,
    instr_660F3837_reg,
    instr_660F3837_mem,
    |d, s| {
        reg128 {
            i64: [
                -((d.i64[0] > s.i64[0]) as i64),
                -((d.i64[1] > s.i64[1]) as i64),
            ],
        }
    }
);

// pminsb, pminsd, pminuw, pminud, pmaxsb, pmaxsd, pmaxuw, pmaxud
macro_rules! lanewise {
    ($field:ident, $n:expr, $f:expr) => {
        |d: reg128, s: reg128| {
            let mut r = d;
            for i in 0..$n {
                r.$field[i] = $f(d.$field[i], s.$field[i]);
            }
            r
        }
    };
}
xmm_op!(
    instr_660F3838,
    instr_660F3838_reg,
    instr_660F3838_mem,
    lanewise!(i8, 16, i8::min)
);
xmm_op!(
    instr_660F3839,
    instr_660F3839_reg,
    instr_660F3839_mem,
    lanewise!(i32, 4, i32::min)
);
xmm_op!(
    instr_660F383A,
    instr_660F383A_reg,
    instr_660F383A_mem,
    lanewise!(u16, 8, u16::min)
);
xmm_op!(
    instr_660F383B,
    instr_660F383B_reg,
    instr_660F383B_mem,
    lanewise!(u32, 4, u32::min)
);
xmm_op!(
    instr_660F383C,
    instr_660F383C_reg,
    instr_660F383C_mem,
    lanewise!(i8, 16, i8::max)
);
xmm_op!(
    instr_660F383D,
    instr_660F383D_reg,
    instr_660F383D_mem,
    lanewise!(i32, 4, i32::max)
);
xmm_op!(
    instr_660F383E,
    instr_660F383E_reg,
    instr_660F383E_mem,
    lanewise!(u16, 8, u16::max)
);
xmm_op!(
    instr_660F383F,
    instr_660F383F_reg,
    instr_660F383F_mem,
    lanewise!(u32, 4, u32::max)
);

// pmulld: low dwords of the products
xmm_op!(
    instr_660F3840,
    instr_660F3840_reg,
    instr_660F3840_mem,
    lanewise!(i32, 4, i32::wrapping_mul)
);

// phminposuw: the minimum unsigned word of the source and its (lowest) index
xmm_op!(
    instr_660F3841,
    instr_660F3841_reg,
    instr_660F3841_mem,
    |_d, s| {
        let mut index = 0;
        for i in 1..8 {
            if s.u16[i] < s.u16[index] {
                index = i;
            }
        }
        reg128 {
            u64: [s.u16[index] as u64 | (index as u64) << 16, 0],
        }
    }
);

// crc32 (sse4.2): crc32c of the source into the low dword of the destination register
fn crc32c(mut crc: u32, value: u64, bytes: usize) -> u32 {
    for i in 0..bytes {
        crc ^= (value >> (8 * i)) as u8 as u32;
        for _ in 0..8 {
            crc = crc >> 1 ^ 0x82F6_3B78 & (crc & 1).wrapping_neg();
        }
    }
    crc
}
unsafe fn crc32_into(r: i32, value: u64, bytes: usize) {
    // also with REX.W: the crc is zero-extended into the 64-bit register
    write_reg32(r, crc32c(read_reg32(r) as u32, value, bytes) as i32);
}
// crc32 r32/r64, r/m8 (the operand size doesn't change the source size)
#[no_mangle]
pub unsafe fn instr16_F20F38F0_reg(r1: i32, r: i32) { crc32_into(r, read_reg8(r1) as u64, 1) }
#[no_mangle]
pub unsafe fn instr16_F20F38F0_mem(addr: u64, r: i32) {
    crc32_into(r, return_on_pagefault!(safe_read8(addr)) as u64, 1)
}
#[no_mangle]
pub unsafe fn instr32_F20F38F0_reg(r1: i32, r: i32) { instr16_F20F38F0_reg(r1, r) }
#[no_mangle]
pub unsafe fn instr32_F20F38F0_mem(addr: u64, r: i32) { instr16_F20F38F0_mem(addr, r) }
pub unsafe fn instr64_F20F38F0_reg(r1: i32, r: i32) { instr16_F20F38F0_reg(r1, r) }
pub unsafe fn instr64_F20F38F0_mem(addr: u64, r: i32) { instr16_F20F38F0_mem(addr, r) }
// crc32 r32, r/m16; r32, r/m32; r64, r/m64
#[no_mangle]
pub unsafe fn instr16_F20F38F1_reg(r1: i32, r: i32) { crc32_into(r, read_reg16(r1) as u64, 2) }
#[no_mangle]
pub unsafe fn instr16_F20F38F1_mem(addr: u64, r: i32) {
    crc32_into(r, return_on_pagefault!(safe_read16(addr)) as u64, 2)
}
#[no_mangle]
pub unsafe fn instr32_F20F38F1_reg(r1: i32, r: i32) {
    crc32_into(r, read_reg32(r1) as u32 as u64, 4)
}
#[no_mangle]
pub unsafe fn instr32_F20F38F1_mem(addr: u64, r: i32) {
    crc32_into(r, return_on_pagefault!(safe_read32s(addr)) as u32 as u64, 4)
}
pub unsafe fn instr64_F20F38F1_reg(r1: i32, r: i32) { crc32_into(r, read_reg64(r1), 8) }
pub unsafe fn instr64_F20F38F1_mem(addr: u64, r: i32) {
    crc32_into(r, return_on_pagefault!(safe_read64s(addr)), 8)
}

// roundps, roundpd, roundss, roundsd: imm8 bits 1:0 give the rounding mode, bit 2 selects
// mxcsr.rc instead, bit 3 (suppress the precision exception) has no effect here
fn rounding_mode(imm8: i32) -> i32 {
    if imm8 & 4 != 0 {
        unsafe { *mxcsr >> 13 & 3 }
    }
    else {
        imm8 & 3
    }
}
fn round_f32(x: f32, mode: i32) -> f32 {
    if x.is_nan() {
        return quiet_f32(x);
    }
    match mode {
        0 => x.round_ties_even(),
        1 => x.floor(),
        2 => x.ceil(),
        _ => x.trunc(),
    }
}
fn round_f64(x: f64, mode: i32) -> f64 {
    if x.is_nan() {
        return quiet_f64(x);
    }
    match mode {
        0 => x.round_ties_even(),
        1 => x.floor(),
        2 => x.ceil(),
        _ => x.trunc(),
    }
}
xmm_op_imm!(
    instr_660F3A08,
    instr_660F3A08_reg,
    instr_660F3A08_mem,
    |_d, s, imm| {
        let mode = rounding_mode(imm);
        reg128 {
            f32: [
                round_f32(s.f32[0], mode),
                round_f32(s.f32[1], mode),
                round_f32(s.f32[2], mode),
                round_f32(s.f32[3], mode),
            ],
        }
    }
);
xmm_op_imm!(
    instr_660F3A09,
    instr_660F3A09_reg,
    instr_660F3A09_mem,
    |_d, s, imm| {
        let mode = rounding_mode(imm);
        reg128 {
            f64: [round_f64(s.f64[0], mode), round_f64(s.f64[1], mode)],
        }
    }
);
pub unsafe fn instr_660F3A0A(source: f32, r: i32, imm8: i32) {
    write_xmm_f32(r, round_f32(source, rounding_mode(imm8)));
}
#[no_mangle]
pub unsafe fn instr_660F3A0A_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0A(read_xmm_f32(r1), r2, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A0A_mem(addr: u64, r: i32, imm: i32) {
    instr_660F3A0A(
        f32::from_bits(return_on_pagefault!(safe_read32s(addr)) as u32),
        r,
        imm,
    )
}
pub unsafe fn instr_660F3A0B(source: f64, r: i32, imm8: i32) {
    write_xmm_f64(r, round_f64(source, rounding_mode(imm8)));
}
#[no_mangle]
pub unsafe fn instr_660F3A0B_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0B(f64::from_bits(read_xmm64s(r1)), r2, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A0B_mem(addr: u64, r: i32, imm: i32) {
    instr_660F3A0B(
        f64::from_bits(return_on_pagefault!(safe_read64s(addr))),
        r,
        imm,
    )
}

// blendps, blendpd, pblendw: select the source's element i if bit i of imm8 is set
xmm_op_imm!(
    instr_660F3A0C,
    instr_660F3A0C_reg,
    instr_660F3A0C_mem,
    |d, s, imm| {
        let mut r = d;
        for i in 0..4 {
            if imm & 1 << i != 0 {
                r.u32[i] = s.u32[i];
            }
        }
        r
    }
);
xmm_op_imm!(
    instr_660F3A0D,
    instr_660F3A0D_reg,
    instr_660F3A0D_mem,
    |d, s, imm| {
        let mut r = d;
        for i in 0..2 {
            if imm & 1 << i != 0 {
                r.u64[i] = s.u64[i];
            }
        }
        r
    }
);
xmm_op_imm!(
    instr_660F3A0E,
    instr_660F3A0E_reg,
    instr_660F3A0E_mem,
    |d, s, imm| {
        let mut r = d;
        for i in 0..8 {
            if imm & 1 << i != 0 {
                r.u16[i] = s.u16[i];
            }
        }
        r
    }
);

// pextrb, pextrw, pextrd/pextrq, extractps: r1 (or the memory operand) is the destination, r2
// the xmm source; register destinations are zero-extended
#[no_mangle]
pub unsafe fn instr_660F3A14_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, read_xmm128s(r2).u8[(imm & 15) as usize] as i32);
}
#[no_mangle]
pub unsafe fn instr_660F3A14_mem(addr: u64, r: i32, imm: i32) {
    return_on_pagefault!(safe_write8(
        addr,
        read_xmm128s(r).u8[(imm & 15) as usize] as i32
    ));
}
#[no_mangle]
pub unsafe fn instr_660F3A15_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, read_xmm128s(r2).u16[(imm & 7) as usize] as i32);
}
#[no_mangle]
pub unsafe fn instr_660F3A15_mem(addr: u64, r: i32, imm: i32) {
    return_on_pagefault!(safe_write16(
        addr,
        read_xmm128s(r).u16[(imm & 7) as usize] as i32
    ));
}
#[no_mangle]
pub unsafe fn instr_660F3A16_reg(r1: i32, r2: i32, imm: i32) {
    let x = read_xmm128s(r2);
    if rex_w() {
        write_reg64(r1, x.u64[(imm & 1) as usize]);
    }
    else {
        write_reg32(r1, x.i32[(imm & 3) as usize]);
    }
}
#[no_mangle]
pub unsafe fn instr_660F3A16_mem(addr: u64, r: i32, imm: i32) {
    let x = read_xmm128s(r);
    if rex_w() {
        return_on_pagefault!(safe_write64(addr, x.u64[(imm & 1) as usize]));
    }
    else {
        return_on_pagefault!(safe_write32(addr, x.i32[(imm & 3) as usize]));
    }
}
#[no_mangle]
pub unsafe fn instr_660F3A17_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, read_xmm128s(r2).i32[(imm & 3) as usize]);
}
#[no_mangle]
pub unsafe fn instr_660F3A17_mem(addr: u64, r: i32, imm: i32) {
    return_on_pagefault!(safe_write32(addr, read_xmm128s(r).i32[(imm & 3) as usize]));
}

// pinsrb, insertps, pinsrd/pinsrq: r1 (or the memory operand) is the source, r2 the xmm
// destination
pub unsafe fn instr_660F3A20(source: i32, r: i32, imm8: i32) {
    let mut x = read_xmm128s(r);
    x.u8[(imm8 & 15) as usize] = source as u8;
    write_xmm_reg128(r, x);
}
#[no_mangle]
pub unsafe fn instr_660F3A20_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A20(read_reg32(r1), r2, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A20_mem(addr: u64, r: i32, imm: i32) {
    instr_660F3A20(return_on_pagefault!(safe_read8(addr)), r, imm)
}
// insertps: the source dword (imm8 bits 7:6 select it from a register source) goes to the
// destination dword selected by bits 5:4, then the dwords in the mask of bits 3:0 are cleared
pub unsafe fn instr_660F3A21(source: u32, r: i32, imm8: i32) {
    let mut x = read_xmm128s(r);
    x.u32[(imm8 >> 4 & 3) as usize] = source;
    for i in 0..4 {
        if imm8 & 1 << i != 0 {
            x.u32[i] = 0;
        }
    }
    write_xmm_reg128(r, x);
}
#[no_mangle]
pub unsafe fn instr_660F3A21_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A21(read_xmm128s(r1).u32[(imm >> 6 & 3) as usize], r2, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A21_mem(addr: u64, r: i32, imm: i32) {
    instr_660F3A21(return_on_pagefault!(safe_read32s(addr)) as u32, r, imm)
}
#[no_mangle]
pub unsafe fn instr_660F3A22_reg(r1: i32, r2: i32, imm: i32) {
    let mut x = read_xmm128s(r2);
    if rex_w() {
        x.u64[(imm & 1) as usize] = read_reg64(r1);
    }
    else {
        x.i32[(imm & 3) as usize] = read_reg32(r1);
    }
    write_xmm_reg128(r2, x);
}
#[no_mangle]
pub unsafe fn instr_660F3A22_mem(addr: u64, r: i32, imm: i32) {
    let mut x = read_xmm128s(r);
    if rex_w() {
        x.u64[(imm & 1) as usize] = return_on_pagefault!(safe_read64s(addr));
    }
    else {
        x.i32[(imm & 3) as usize] = return_on_pagefault!(safe_read32s(addr));
    }
    write_xmm_reg128(r, x);
}

// dpps, dppd: the products selected by imm8 bits 7:4 are summed ((p0 + p1) + (p2 + p3)), the sum
// is written to the elements selected by bits 3:0, the others are cleared
xmm_op_imm!(
    instr_660F3A40,
    instr_660F3A40_reg,
    instr_660F3A40_mem,
    |d, s, imm| {
        let mut p = [0.0f32; 4];
        for i in 0..4 {
            if imm & 0x10 << i != 0 {
                p[i] = mul_f32(d.f32[i], s.f32[i]);
            }
        }
        let sum = add_f32(add_f32(p[0], p[1]), add_f32(p[2], p[3]));
        let mut r = reg128 { f32: [0.0; 4] };
        for i in 0..4 {
            if imm & 1 << i != 0 {
                r.f32[i] = sum;
            }
        }
        r
    }
);
xmm_op_imm!(
    instr_660F3A41,
    instr_660F3A41_reg,
    instr_660F3A41_mem,
    |d, s, imm| {
        let mut p = [0.0f64; 2];
        for i in 0..2 {
            if imm & 0x10 << i != 0 {
                p[i] = mul_f64(d.f64[i], s.f64[i]);
            }
        }
        let sum = add_f64(p[0], p[1]);
        let mut r = reg128 { f64: [0.0; 2] };
        for i in 0..2 {
            if imm & 1 << i != 0 {
                r.f64[i] = sum;
            }
        }
        r
    }
);

// mpsadbw: sums of absolute differences of the source dword selected by imm8 bits 1:0 against
// 8 overlapping 4-byte windows of the destination, starting at byte 4 * bit 2
xmm_op_imm!(
    instr_660F3A42,
    instr_660F3A42_reg,
    instr_660F3A42_mem,
    |d, s, imm| {
        let source_offset = ((imm & 3) * 4) as usize;
        let destination_offset = ((imm >> 2 & 1) * 4) as usize;
        let mut r = reg128 { u16: [0; 8] };
        for i in 0..8 {
            let mut sum = 0;
            for j in 0..4 {
                sum += (d.u8[destination_offset + i + j] as i32 - s.u8[source_offset + j] as i32)
                    .unsigned_abs();
            }
            r.u16[i] = sum as u16;
        }
        r
    }
);

// pcmpestrm, pcmpestri, pcmpistrm, pcmpistri (sse4.2): compare the elements of the destination
// register (a) with those of the source (b), as selected by imm8:
//   bits 1:0: element format (unsigned bytes, unsigned words, signed bytes, signed words)
//   bits 3:2: aggregation (equal any, ranges, equal each, equal ordered)
//   bits 5:4: polarity (positive, negative, masked positive, masked negative)
//   bit 6: least or most significant index / bit or element mask
// String lengths are explicit (eax/rax and edx/rdx) or implicit (up to the first zero element).
struct StrCmp {
    /// result bits, one per element
    result: u32,
    elements: u32,
    len_a: u32,
    len_b: u32,
}

fn pcmpstr(a: reg128, b: reg128, explicit: Option<(i64, i64)>, imm8: i32) -> StrCmp {
    let words = imm8 & 1 != 0;
    let signed = imm8 & 2 != 0;
    let n = if words { 8 } else { 16 };
    let element = |x: &reg128, i: u32| -> i32 {
        unsafe {
            match (words, signed) {
                (false, false) => x.u8[i as usize] as i32,
                (false, true) => x.i8[i as usize] as i32,
                (true, false) => x.u16[i as usize] as i32,
                (true, true) => x.i16[i as usize] as i32,
            }
        }
    };
    let implicit_len = |x: &reg128| (0..n).find(|&i| element(x, i) == 0).unwrap_or(n);
    let (len_a, len_b) = match explicit {
        Some((la, lb)) => (
            la.unsigned_abs().min(n as u64) as u32,
            lb.unsigned_abs().min(n as u64) as u32,
        ),
        None => (implicit_len(&a), implicit_len(&b)),
    };

    let mut result1 = 0u32;
    match imm8 >> 2 & 3 {
        0 => {
            // equal any: b[j] equals some valid a[i]
            for j in 0..len_b {
                if (0..len_a).any(|i| element(&a, i) == element(&b, j)) {
                    result1 |= 1 << j;
                }
            }
        },
        1 => {
            // ranges: a[i] <= b[j] <= a[i + 1] for some valid pair (i even)
            for j in 0..len_b {
                let bj = element(&b, j);
                let mut i = 0;
                while i + 1 < len_a {
                    if element(&a, i) <= bj && bj <= element(&a, i + 1) {
                        result1 |= 1 << j;
                        break;
                    }
                    i += 2;
                }
            }
        },
        2 => {
            // equal each: a[j] == b[j]; true where both are invalid, false where one is
            for j in 0..n {
                let equal = match (j < len_a, j < len_b) {
                    (true, true) => element(&a, j) == element(&b, j),
                    (false, false) => true,
                    _ => false,
                };
                if equal {
                    result1 |= 1 << j;
                }
            }
        },
        _ => {
            // equal ordered: a occurs in b at position j; invalid elements of a match anything,
            // valid ones don't match invalid elements of b
            for j in 0..n {
                let matches = (0..n - j).all(|k| {
                    if k >= len_a {
                        true
                    }
                    else if j + k >= len_b {
                        false
                    }
                    else {
                        element(&a, k) == element(&b, j + k)
                    }
                });
                if matches {
                    result1 |= 1 << j;
                }
            }
        },
    }

    let all = (1u32 << n) - 1;
    let result = match imm8 >> 4 & 3 {
        1 => !result1 & all,
        3 => result1 ^ ((1u32 << len_b) - 1),
        _ => result1,
    };
    StrCmp {
        result,
        elements: n,
        len_a,
        len_b,
    }
}

unsafe fn pcmpstr_set_flags(c: &StrCmp) {
    *flags_changed = 0;
    *flags = *flags & !FLAGS_ALL
        | if c.result != 0 { FLAG_CARRY } else { 0 }
        | if c.len_b < c.elements { FLAG_ZERO } else { 0 }
        | if c.len_a < c.elements { FLAG_SIGN } else { 0 }
        | if c.result & 1 != 0 { FLAG_OVERFLOW } else { 0 };
}
unsafe fn pcmpstr_index(c: &StrCmp, imm8: i32) {
    let index = if c.result == 0 {
        c.elements
    }
    else if imm8 & 0x40 != 0 {
        31 - c.result.leading_zeros()
    }
    else {
        c.result.trailing_zeros()
    };
    write_reg32(ECX, index as i32);
    pcmpstr_set_flags(c);
}
unsafe fn pcmpstr_mask(c: &StrCmp, imm8: i32) {
    let mut mask = reg128 { u64: [0, 0] };
    if imm8 & 0x40 == 0 {
        mask.u32[0] = c.result;
    }
    else {
        for i in 0..c.elements as usize {
            let set = c.result & 1 << i != 0;
            if c.elements == 8 {
                mask.u16[i] = if set { 0xFFFF } else { 0 };
            }
            else {
                mask.u8[i] = if set { 0xFF } else { 0 };
            }
        }
    }
    write_xmm_reg128(0, mask);
    pcmpstr_set_flags(c);
}
unsafe fn explicit_lengths() -> (i64, i64) {
    if rex_w() {
        (read_reg64(EAX) as i64, read_reg64(EDX) as i64)
    }
    else {
        (read_reg32(EAX) as i64, read_reg32(EDX) as i64)
    }
}
pub unsafe fn instr_660F3A60(source: reg128, r: i32, imm8: i32) {
    let c = pcmpstr(read_xmm128s(r), source, Some(explicit_lengths()), imm8);
    pcmpstr_mask(&c, imm8);
}
pub unsafe fn instr_660F3A61(source: reg128, r: i32, imm8: i32) {
    let c = pcmpstr(read_xmm128s(r), source, Some(explicit_lengths()), imm8);
    pcmpstr_index(&c, imm8);
}
pub unsafe fn instr_660F3A62(source: reg128, r: i32, imm8: i32) {
    let c = pcmpstr(read_xmm128s(r), source, None, imm8);
    pcmpstr_mask(&c, imm8);
}
pub unsafe fn instr_660F3A63(source: reg128, r: i32, imm8: i32) {
    let c = pcmpstr(read_xmm128s(r), source, None, imm8);
    pcmpstr_index(&c, imm8);
}
macro_rules! pcmpstr_forms {
    ($name:ident, $name_reg:ident, $name_mem:ident) => {
        #[no_mangle]
        pub unsafe fn $name_reg(r1: i32, r2: i32, imm: i32) {
            $name(read_xmm128s(r1), r2, imm & 0xFF)
        }
        #[no_mangle]
        pub unsafe fn $name_mem(addr: u64, r: i32, imm: i32) {
            $name(return_on_pagefault!(safe_read128s(addr)), r, imm & 0xFF)
        }
    };
}
pcmpstr_forms!(instr_660F3A60, instr_660F3A60_reg, instr_660F3A60_mem);
pcmpstr_forms!(instr_660F3A61, instr_660F3A61_reg, instr_660F3A61_mem);
pcmpstr_forms!(instr_660F3A62, instr_660F3A62_reg, instr_660F3A62_mem);
pcmpstr_forms!(instr_660F3A63, instr_660F3A63_reg, instr_660F3A63_mem);
