//! Raw access to guest RAM by host offset (see memory::phys_to_host). All reads and writes of
//! guest RAM from Rust go through here, so that guest RAM can live in a separate wasm memory.
//! No mmio, dirty or bounds checks are done here.
//!
//! In the default build, guest RAM is part of the core's memory, starting at memory::mem8. With
//! the mem64 feature, guest RAM is a separate 64-bit memory (memory index 1) and the accesses
//! are done by the v86_guest_* functions below, whose bodies are replaced by
//! tools/patch-mem64.mjs after linking (rust can't access a second memory).

use crate::cpu::cpu::reg128;
#[cfg(not(feature = "mem64"))]
use crate::cpu::memory::mem8;
use std::ptr;

#[cfg(not(feature = "mem64"))]
mod imp {
    use super::*;

    // guest RAM may be larger than isize::MAX, so the pointer arithmetic must not use offset
    #[inline(always)]
    fn host_ptr(offset: u64) -> *mut u8 { unsafe { mem8.wrapping_add(offset as usize) } }

    #[inline(always)]
    pub fn load8(offset: u64) -> u8 { unsafe { *host_ptr(offset) } }
    #[inline(always)]
    pub fn load16(offset: u64) -> u16 { unsafe { ptr::read_unaligned(host_ptr(offset) as *const u16) } }
    #[inline(always)]
    pub fn load32(offset: u64) -> u32 { unsafe { ptr::read_unaligned(host_ptr(offset) as *const u32) } }
    #[inline(always)]
    pub fn load64(offset: u64) -> u64 { unsafe { ptr::read_unaligned(host_ptr(offset) as *const u64) } }

    #[inline(always)]
    pub fn store8(offset: u64, value: u8) { unsafe { *host_ptr(offset) = value } }
    #[inline(always)]
    pub fn store16(offset: u64, value: u16) {
        unsafe { ptr::write_unaligned(host_ptr(offset) as *mut u16, value) }
    }
    #[inline(always)]
    pub fn store32(offset: u64, value: u32) {
        unsafe { ptr::write_unaligned(host_ptr(offset) as *mut u32, value) }
    }
    #[inline(always)]
    pub fn store64(offset: u64, value: u64) {
        unsafe { ptr::write_unaligned(host_ptr(offset) as *mut u64, value) }
    }

    #[inline(always)]
    pub fn fill(offset: u64, value: u8, count: u64) {
        unsafe { ptr::write_bytes(host_ptr(offset), value, count as usize) }
    }
    #[inline(always)]
    pub fn copy(src: u64, dst: u64, count: u64) {
        unsafe { ptr::copy(host_ptr(src), host_ptr(dst), count as usize) }
    }
    #[inline(always)]
    pub unsafe fn copy_to_core(src: u64, dst: *mut u8, count: u32) {
        ptr::copy_nonoverlapping(host_ptr(src), dst, count as usize)
    }
    #[inline(always)]
    pub unsafe fn copy_from_core(src: *const u8, dst: u64, count: u32) {
        ptr::copy_nonoverlapping(src, host_ptr(dst), count as usize)
    }
}

#[cfg(feature = "mem64")]
mod imp {
    use super::*;

    // Placeholders, see the module comment. They must stay separate, non-inlined functions with
    // these exact signatures (checked by the patch tool). The volatile accesses to distinct
    // statics keep LLVM from merging them or deriving facts about them from their bodies.
    static mut PLACEHOLDER: [u64; 12] = [0; 12];
    macro_rules! placeholder {
        ($i:expr, $($arg:expr),*) => {
            unsafe {
                let p = &raw mut PLACEHOLDER[$i];
                let mut x = ptr::read_volatile(p);
                $(x ^= $arg as u64;)*
                ptr::write_volatile(p, x);
                x
            }
        };
    }

    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_load8(offset: u64) -> u32 { placeholder!(0, offset) as u32 }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_load16(offset: u64) -> u32 { placeholder!(1, offset) as u32 }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_load32(offset: u64) -> u32 { placeholder!(2, offset) as u32 }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_load64(offset: u64) -> u64 { placeholder!(3, offset) }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_store8(offset: u64, value: u32) { placeholder!(4, offset, value); }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_store16(offset: u64, value: u32) { placeholder!(5, offset, value); }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_store32(offset: u64, value: u32) { placeholder!(6, offset, value); }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_store64(offset: u64, value: u64) { placeholder!(7, offset, value); }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_fill(offset: u64, value: u32, count: u64) {
        placeholder!(8, offset, value, count);
    }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_copy(src: u64, dst: u64, count: u64) {
        placeholder!(9, src, dst, count);
    }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_copy_to_core(src: u64, dst: *mut u8, count: u32) {
        placeholder!(10, src, dst as u32, count);
    }
    #[no_mangle]
    #[inline(never)]
    pub extern "C" fn v86_guest_copy_from_core(src: *const u8, dst: u64, count: u32) {
        placeholder!(11, src as u32, dst, count);
    }

    #[inline(always)]
    pub fn load8(offset: u64) -> u8 { v86_guest_load8(offset) as u8 }
    #[inline(always)]
    pub fn load16(offset: u64) -> u16 { v86_guest_load16(offset) as u16 }
    #[inline(always)]
    pub fn load32(offset: u64) -> u32 { v86_guest_load32(offset) }
    #[inline(always)]
    pub fn load64(offset: u64) -> u64 { v86_guest_load64(offset) }

    #[inline(always)]
    pub fn store8(offset: u64, value: u8) { v86_guest_store8(offset, value as u32) }
    #[inline(always)]
    pub fn store16(offset: u64, value: u16) { v86_guest_store16(offset, value as u32) }
    #[inline(always)]
    pub fn store32(offset: u64, value: u32) { v86_guest_store32(offset, value) }
    #[inline(always)]
    pub fn store64(offset: u64, value: u64) { v86_guest_store64(offset, value) }

    #[inline(always)]
    pub fn fill(offset: u64, value: u8, count: u64) { v86_guest_fill(offset, value as u32, count) }
    #[inline(always)]
    pub fn copy(src: u64, dst: u64, count: u64) { v86_guest_copy(src, dst, count) }
    #[inline(always)]
    pub unsafe fn copy_to_core(src: u64, dst: *mut u8, count: u32) {
        v86_guest_copy_to_core(src, dst, count)
    }
    #[inline(always)]
    pub unsafe fn copy_from_core(src: *const u8, dst: u64, count: u32) {
        v86_guest_copy_from_core(src, dst, count)
    }
}

pub use imp::*;

#[inline(always)]
pub fn load128(offset: u64) -> reg128 {
    reg128 {
        u64: [load64(offset), load64(offset + 8)],
    }
}
#[inline(always)]
pub fn store128(offset: u64, value: reg128) {
    store64(offset, unsafe { value.u64[0] });
    store64(offset + 8, unsafe { value.u64[1] });
}
