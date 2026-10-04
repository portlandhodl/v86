//! Fast non-cryptographic hashing for the jit's maps (the std hasher, SipHash, is
//! comparatively slow, and the maps are accessed on hot paths, e.g. after every run of the
//! interpreter and on tlb misses). Keys are page numbers and addresses, not attacker-chosen
//! in a way that matters here.

use std::collections;
use std::hash::{BuildHasherDefault, Hasher};

/// The hasher used by rustc (FxHash)
#[derive(Default, Clone, Copy)]
pub struct FxHasher {
    hash: u64,
}

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl FxHasher {
    #[inline]
    fn add_to_hash(&mut self, i: u64) {
        self.hash = (self.hash.rotate_left(5) ^ i).wrapping_mul(SEED);
    }
}

impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.add_to_hash(b as u64);
        }
    }
    #[inline]
    fn write_u8(&mut self, i: u8) { self.add_to_hash(i as u64) }
    #[inline]
    fn write_u16(&mut self, i: u16) { self.add_to_hash(i as u64) }
    #[inline]
    fn write_u32(&mut self, i: u32) { self.add_to_hash(i as u64) }
    #[inline]
    fn write_u64(&mut self, i: u64) { self.add_to_hash(i) }
    #[inline]
    fn write_usize(&mut self, i: usize) { self.add_to_hash(i as u64) }
    #[inline]
    fn finish(&self) -> u64 { self.hash }
}

pub type HashMap<K, V> = collections::HashMap<K, V, BuildHasherDefault<FxHasher>>;
pub type HashSet<K> = collections::HashSet<K, BuildHasherDefault<FxHasher>>;
