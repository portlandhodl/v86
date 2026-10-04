use crate::cpu::cpu::translate_address_system_read;

#[no_mangle]
pub unsafe fn translate_address_system_read_js(addr: i32) -> u32 {
    let phys = translate_address_system_read(addr as u32 as u64).unwrap();
    dbg_assert!(phys <= u32::MAX as u64);
    phys as u32
}
