#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

/// Call a module for 64-bit code, which gets the registers as arguments
#[no_mangle]
pub unsafe fn call_indirect_jit64(
    f: fn(u16, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64),
    x: u16,
) {
    use crate::cpu::cpu::read_reg64;
    f(
        x,
        read_reg64(0),
        read_reg64(1),
        read_reg64(2),
        read_reg64(3),
        read_reg64(4),
        read_reg64(5),
        read_reg64(6),
        read_reg64(7),
        read_reg64(8),
        read_reg64(9),
        read_reg64(10),
        read_reg64(11),
        read_reg64(12),
        read_reg64(13),
        read_reg64(14),
        read_reg64(15),
    );
}
