/// A physical page number. Physical addresses are u64 (RAM may be mapped above 4 GiB); the page
/// number fits in u32 for physical addresses below 16 TiB.
#[derive(Copy, Clone, Eq, Hash, PartialEq)]
pub struct Page(u32);
impl Page {
    pub fn page_of(address: u64) -> Page {
        dbg_assert!(address >> 12 <= u32::MAX as u64);
        Page((address >> 12) as u32)
    }
    pub fn to_address(self) -> u64 { (self.0 as u64) << 12 }

    pub fn to_u32(self) -> u32 { self.0 }
    pub fn of_u32(page: u32) -> Page { Page(page) }
}
