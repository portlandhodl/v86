// 64-bit instruction implementations (long mode).
// Filled in incrementally; unimplemented ones panic (only reachable in 64-bit mode).
#![allow(unused_variables)]
#![allow(clippy::all)]

use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::cpu::memory;
use crate::cpu::modrm;
use crate::prefix;
use crate::regs;

pub unsafe fn instr64_01_mem(a0: i32, a1: i32) { unimplemented!("instr64_01_mem") }
pub unsafe fn instr64_01_reg(a0: i32, a1: i32) { unimplemented!("instr64_01_reg") }
pub unsafe fn instr64_03_mem(a0: i32, a1: i32) { unimplemented!("instr64_03_mem") }
pub unsafe fn instr64_03_reg(a0: i32, a1: i32) { unimplemented!("instr64_03_reg") }
pub unsafe fn instr64_05(a0: i32) { unimplemented!("instr64_05") }
pub unsafe fn instr64_06() { unimplemented!("instr64_06") }
pub unsafe fn instr64_07() { unimplemented!("instr64_07") }
pub unsafe fn instr64_09_mem(a0: i32, a1: i32) { unimplemented!("instr64_09_mem") }
pub unsafe fn instr64_09_reg(a0: i32, a1: i32) { unimplemented!("instr64_09_reg") }
pub unsafe fn instr64_0B_mem(a0: i32, a1: i32) { unimplemented!("instr64_0B_mem") }
pub unsafe fn instr64_0B_reg(a0: i32, a1: i32) { unimplemented!("instr64_0B_reg") }
pub unsafe fn instr64_0D(a0: i32) { unimplemented!("instr64_0D") }
pub unsafe fn instr64_0E() { unimplemented!("instr64_0E") }
pub unsafe fn instr64_0F() { unimplemented!("instr64_0F") }
pub unsafe fn instr64_0F00_0_mem(a0: i32) { unimplemented!("instr64_0F00_0_mem") }
pub unsafe fn instr64_0F00_0_reg(a0: i32) { unimplemented!("instr64_0F00_0_reg") }
pub unsafe fn instr64_0F00_1_mem(a0: i32) { unimplemented!("instr64_0F00_1_mem") }
pub unsafe fn instr64_0F00_1_reg(a0: i32) { unimplemented!("instr64_0F00_1_reg") }
pub unsafe fn instr64_0F00_2_mem(a0: i32) { unimplemented!("instr64_0F00_2_mem") }
pub unsafe fn instr64_0F00_2_reg(a0: i32) { unimplemented!("instr64_0F00_2_reg") }
pub unsafe fn instr64_0F00_3_mem(a0: i32) { unimplemented!("instr64_0F00_3_mem") }
pub unsafe fn instr64_0F00_3_reg(a0: i32) { unimplemented!("instr64_0F00_3_reg") }
pub unsafe fn instr64_0F00_4_mem(a0: i32) { unimplemented!("instr64_0F00_4_mem") }
pub unsafe fn instr64_0F00_4_reg(a0: i32) { unimplemented!("instr64_0F00_4_reg") }
pub unsafe fn instr64_0F00_5_mem(a0: i32) { unimplemented!("instr64_0F00_5_mem") }
pub unsafe fn instr64_0F00_5_reg(a0: i32) { unimplemented!("instr64_0F00_5_reg") }
pub unsafe fn instr64_0F01_0_mem(a0: i32) { unimplemented!("instr64_0F01_0_mem") }
pub unsafe fn instr64_0F01_0_reg(a0: i32) { unimplemented!("instr64_0F01_0_reg") }
pub unsafe fn instr64_0F01_1_mem(a0: i32) { unimplemented!("instr64_0F01_1_mem") }
pub unsafe fn instr64_0F01_1_reg(a0: i32) { unimplemented!("instr64_0F01_1_reg") }
pub unsafe fn instr64_0F01_2_mem(a0: i32) { unimplemented!("instr64_0F01_2_mem") }
pub unsafe fn instr64_0F01_2_reg(a0: i32) { unimplemented!("instr64_0F01_2_reg") }
pub unsafe fn instr64_0F01_3_mem(a0: i32) { unimplemented!("instr64_0F01_3_mem") }
pub unsafe fn instr64_0F01_3_reg(a0: i32) { unimplemented!("instr64_0F01_3_reg") }
pub unsafe fn instr64_0F01_4_mem(a0: i32) { unimplemented!("instr64_0F01_4_mem") }
pub unsafe fn instr64_0F01_4_reg(a0: i32) { unimplemented!("instr64_0F01_4_reg") }
pub unsafe fn instr64_0F01_6_mem(a0: i32) { unimplemented!("instr64_0F01_6_mem") }
pub unsafe fn instr64_0F01_6_reg(a0: i32) { unimplemented!("instr64_0F01_6_reg") }
pub unsafe fn instr64_0F01_7_mem(a0: i32) { unimplemented!("instr64_0F01_7_mem") }
pub unsafe fn instr64_0F01_7_reg(a0: i32) { unimplemented!("instr64_0F01_7_reg") }
pub unsafe fn instr64_0F02_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F02_mem") }
pub unsafe fn instr64_0F02_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F02_reg") }
pub unsafe fn instr64_0F03_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F03_mem") }
pub unsafe fn instr64_0F03_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F03_reg") }
pub unsafe fn instr64_0F40_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F40_mem") }
pub unsafe fn instr64_0F40_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F40_reg") }
pub unsafe fn instr64_0F41_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F41_mem") }
pub unsafe fn instr64_0F41_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F41_reg") }
pub unsafe fn instr64_0F42_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F42_mem") }
pub unsafe fn instr64_0F42_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F42_reg") }
pub unsafe fn instr64_0F43_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F43_mem") }
pub unsafe fn instr64_0F43_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F43_reg") }
pub unsafe fn instr64_0F44_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F44_mem") }
pub unsafe fn instr64_0F44_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F44_reg") }
pub unsafe fn instr64_0F45_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F45_mem") }
pub unsafe fn instr64_0F45_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F45_reg") }
pub unsafe fn instr64_0F46_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F46_mem") }
pub unsafe fn instr64_0F46_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F46_reg") }
pub unsafe fn instr64_0F47_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F47_mem") }
pub unsafe fn instr64_0F47_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F47_reg") }
pub unsafe fn instr64_0F48_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F48_mem") }
pub unsafe fn instr64_0F48_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F48_reg") }
pub unsafe fn instr64_0F49_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F49_mem") }
pub unsafe fn instr64_0F49_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F49_reg") }
pub unsafe fn instr64_0F4A_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4A_mem") }
pub unsafe fn instr64_0F4A_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4A_reg") }
pub unsafe fn instr64_0F4B_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4B_mem") }
pub unsafe fn instr64_0F4B_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4B_reg") }
pub unsafe fn instr64_0F4C_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4C_mem") }
pub unsafe fn instr64_0F4C_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4C_reg") }
pub unsafe fn instr64_0F4D_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4D_mem") }
pub unsafe fn instr64_0F4D_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4D_reg") }
pub unsafe fn instr64_0F4E_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4E_mem") }
pub unsafe fn instr64_0F4E_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4E_reg") }
pub unsafe fn instr64_0F4F_mem(a0: i32, a1: i32) { unimplemented!("instr64_0F4F_mem") }
pub unsafe fn instr64_0F4F_reg(a0: i32, a1: i32) { unimplemented!("instr64_0F4F_reg") }
pub unsafe fn instr64_0F80(a0: i32) { unimplemented!("instr64_0F80") }
pub unsafe fn instr64_0F81(a0: i32) { unimplemented!("instr64_0F81") }
pub unsafe fn instr64_0F82(a0: i32) { unimplemented!("instr64_0F82") }
pub unsafe fn instr64_0F83(a0: i32) { unimplemented!("instr64_0F83") }
pub unsafe fn instr64_0F84(a0: i32) { unimplemented!("instr64_0F84") }
pub unsafe fn instr64_0F85(a0: i32) { unimplemented!("instr64_0F85") }
pub unsafe fn instr64_0F86(a0: i32) { unimplemented!("instr64_0F86") }
pub unsafe fn instr64_0F87(a0: i32) { unimplemented!("instr64_0F87") }
pub unsafe fn instr64_0F88(a0: i32) { unimplemented!("instr64_0F88") }
pub unsafe fn instr64_0F89(a0: i32) { unimplemented!("instr64_0F89") }
pub unsafe fn instr64_0F8A(a0: i32) { unimplemented!("instr64_0F8A") }
pub unsafe fn instr64_0F8B(a0: i32) { unimplemented!("instr64_0F8B") }
pub unsafe fn instr64_0F8C(a0: i32) { unimplemented!("instr64_0F8C") }
pub unsafe fn instr64_0F8D(a0: i32) { unimplemented!("instr64_0F8D") }
pub unsafe fn instr64_0F8E(a0: i32) { unimplemented!("instr64_0F8E") }
pub unsafe fn instr64_0F8F(a0: i32) { unimplemented!("instr64_0F8F") }
pub unsafe fn instr64_0FA0() { unimplemented!("instr64_0FA0") }
pub unsafe fn instr64_0FA1() { unimplemented!("instr64_0FA1") }
pub unsafe fn instr64_0FA3_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FA3_mem") }
pub unsafe fn instr64_0FA3_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FA3_reg") }
pub unsafe fn instr64_0FA4_mem(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_0FA4_mem") }
pub unsafe fn instr64_0FA4_reg(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_0FA4_reg") }
pub unsafe fn instr64_0FA5_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FA5_mem") }
pub unsafe fn instr64_0FA5_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FA5_reg") }
pub unsafe fn instr64_0FA8() { unimplemented!("instr64_0FA8") }
pub unsafe fn instr64_0FA9() { unimplemented!("instr64_0FA9") }
pub unsafe fn instr64_0FAB_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FAB_mem") }
pub unsafe fn instr64_0FAB_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FAB_reg") }
pub unsafe fn instr64_0FAC_mem(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_0FAC_mem") }
pub unsafe fn instr64_0FAC_reg(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_0FAC_reg") }
pub unsafe fn instr64_0FAD_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FAD_mem") }
pub unsafe fn instr64_0FAD_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FAD_reg") }
pub unsafe fn instr64_0FAF_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FAF_mem") }
pub unsafe fn instr64_0FAF_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FAF_reg") }
pub unsafe fn instr64_0FB1_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB1_mem") }
pub unsafe fn instr64_0FB1_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB1_reg") }
pub unsafe fn instr64_0FB2_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB2_mem") }
pub unsafe fn instr64_0FB2_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB2_reg") }
pub unsafe fn instr64_0FB3_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB3_mem") }
pub unsafe fn instr64_0FB3_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB3_reg") }
pub unsafe fn instr64_0FB4_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB4_mem") }
pub unsafe fn instr64_0FB4_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB4_reg") }
pub unsafe fn instr64_0FB5_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB5_mem") }
pub unsafe fn instr64_0FB5_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB5_reg") }
pub unsafe fn instr64_0FB6_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB6_mem") }
pub unsafe fn instr64_0FB6_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB6_reg") }
pub unsafe fn instr64_0FB7_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB7_mem") }
pub unsafe fn instr64_0FB7_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB7_reg") }
pub unsafe fn instr64_0FB8_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FB8_mem") }
pub unsafe fn instr64_0FB8_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FB8_reg") }
pub unsafe fn instr64_0FBA_4_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_4_mem") }
pub unsafe fn instr64_0FBA_4_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_4_reg") }
pub unsafe fn instr64_0FBA_5_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_5_mem") }
pub unsafe fn instr64_0FBA_5_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_5_reg") }
pub unsafe fn instr64_0FBA_6_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_6_mem") }
pub unsafe fn instr64_0FBA_6_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_6_reg") }
pub unsafe fn instr64_0FBA_7_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_7_mem") }
pub unsafe fn instr64_0FBA_7_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBA_7_reg") }
pub unsafe fn instr64_0FBB_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBB_mem") }
pub unsafe fn instr64_0FBB_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBB_reg") }
pub unsafe fn instr64_0FBC_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBC_mem") }
pub unsafe fn instr64_0FBC_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBC_reg") }
pub unsafe fn instr64_0FBD_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBD_mem") }
pub unsafe fn instr64_0FBD_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBD_reg") }
pub unsafe fn instr64_0FBE_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBE_mem") }
pub unsafe fn instr64_0FBE_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBE_reg") }
pub unsafe fn instr64_0FBF_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FBF_mem") }
pub unsafe fn instr64_0FBF_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FBF_reg") }
pub unsafe fn instr64_0FC1_mem(a0: i32, a1: i32) { unimplemented!("instr64_0FC1_mem") }
pub unsafe fn instr64_0FC1_reg(a0: i32, a1: i32) { unimplemented!("instr64_0FC1_reg") }
pub unsafe fn instr64_0FC7_1_mem(a0: i32) { unimplemented!("instr64_0FC7_1_mem") }
pub unsafe fn instr64_0FC7_1_reg(a0: i32) { unimplemented!("instr64_0FC7_1_reg") }
pub unsafe fn instr64_0FC7_6_mem(a0: i32) { unimplemented!("instr64_0FC7_6_mem") }
pub unsafe fn instr64_0FC7_6_reg(a0: i32) { unimplemented!("instr64_0FC7_6_reg") }
pub unsafe fn instr64_11_mem(a0: i32, a1: i32) { unimplemented!("instr64_11_mem") }
pub unsafe fn instr64_11_reg(a0: i32, a1: i32) { unimplemented!("instr64_11_reg") }
pub unsafe fn instr64_13_mem(a0: i32, a1: i32) { unimplemented!("instr64_13_mem") }
pub unsafe fn instr64_13_reg(a0: i32, a1: i32) { unimplemented!("instr64_13_reg") }
pub unsafe fn instr64_15(a0: i32) { unimplemented!("instr64_15") }
pub unsafe fn instr64_16() { unimplemented!("instr64_16") }
pub unsafe fn instr64_17() { unimplemented!("instr64_17") }
pub unsafe fn instr64_19_mem(a0: i32, a1: i32) { unimplemented!("instr64_19_mem") }
pub unsafe fn instr64_19_reg(a0: i32, a1: i32) { unimplemented!("instr64_19_reg") }
pub unsafe fn instr64_1B_mem(a0: i32, a1: i32) { unimplemented!("instr64_1B_mem") }
pub unsafe fn instr64_1B_reg(a0: i32, a1: i32) { unimplemented!("instr64_1B_reg") }
pub unsafe fn instr64_1D(a0: i32) { unimplemented!("instr64_1D") }
pub unsafe fn instr64_1E() { unimplemented!("instr64_1E") }
pub unsafe fn instr64_1F() { unimplemented!("instr64_1F") }
pub unsafe fn instr64_21_mem(a0: i32, a1: i32) { unimplemented!("instr64_21_mem") }
pub unsafe fn instr64_21_reg(a0: i32, a1: i32) { unimplemented!("instr64_21_reg") }
pub unsafe fn instr64_23_mem(a0: i32, a1: i32) { unimplemented!("instr64_23_mem") }
pub unsafe fn instr64_23_reg(a0: i32, a1: i32) { unimplemented!("instr64_23_reg") }
pub unsafe fn instr64_25(a0: i32) { unimplemented!("instr64_25") }
pub unsafe fn instr64_29_mem(a0: i32, a1: i32) { unimplemented!("instr64_29_mem") }
pub unsafe fn instr64_29_reg(a0: i32, a1: i32) { unimplemented!("instr64_29_reg") }
pub unsafe fn instr64_2B_mem(a0: i32, a1: i32) { unimplemented!("instr64_2B_mem") }
pub unsafe fn instr64_2B_reg(a0: i32, a1: i32) { unimplemented!("instr64_2B_reg") }
pub unsafe fn instr64_2D(a0: i32) { unimplemented!("instr64_2D") }
pub unsafe fn instr64_31_mem(a0: i32, a1: i32) { unimplemented!("instr64_31_mem") }
pub unsafe fn instr64_31_reg(a0: i32, a1: i32) { unimplemented!("instr64_31_reg") }
pub unsafe fn instr64_33_mem(a0: i32, a1: i32) { unimplemented!("instr64_33_mem") }
pub unsafe fn instr64_33_reg(a0: i32, a1: i32) { unimplemented!("instr64_33_reg") }
pub unsafe fn instr64_35(a0: i32) { unimplemented!("instr64_35") }
pub unsafe fn instr64_39_mem(a0: i32, a1: i32) { unimplemented!("instr64_39_mem") }
pub unsafe fn instr64_39_reg(a0: i32, a1: i32) { unimplemented!("instr64_39_reg") }
pub unsafe fn instr64_3B_mem(a0: i32, a1: i32) { unimplemented!("instr64_3B_mem") }
pub unsafe fn instr64_3B_reg(a0: i32, a1: i32) { unimplemented!("instr64_3B_reg") }
pub unsafe fn instr64_3D(a0: i32) { unimplemented!("instr64_3D") }
pub unsafe fn instr64_40() { unimplemented!("instr64_40") }
pub unsafe fn instr64_41() { unimplemented!("instr64_41") }
pub unsafe fn instr64_42() { unimplemented!("instr64_42") }
pub unsafe fn instr64_43() { unimplemented!("instr64_43") }
pub unsafe fn instr64_44() { unimplemented!("instr64_44") }
pub unsafe fn instr64_45() { unimplemented!("instr64_45") }
pub unsafe fn instr64_46() { unimplemented!("instr64_46") }
pub unsafe fn instr64_47() { unimplemented!("instr64_47") }
pub unsafe fn instr64_48() { unimplemented!("instr64_48") }
pub unsafe fn instr64_49() { unimplemented!("instr64_49") }
pub unsafe fn instr64_4A() { unimplemented!("instr64_4A") }
pub unsafe fn instr64_4B() { unimplemented!("instr64_4B") }
pub unsafe fn instr64_4C() { unimplemented!("instr64_4C") }
pub unsafe fn instr64_4D() { unimplemented!("instr64_4D") }
pub unsafe fn instr64_4E() { unimplemented!("instr64_4E") }
pub unsafe fn instr64_4F() { unimplemented!("instr64_4F") }
pub unsafe fn instr64_50() { unimplemented!("instr64_50") }
pub unsafe fn instr64_51() { unimplemented!("instr64_51") }
pub unsafe fn instr64_52() { unimplemented!("instr64_52") }
pub unsafe fn instr64_53() { unimplemented!("instr64_53") }
pub unsafe fn instr64_54() { unimplemented!("instr64_54") }
pub unsafe fn instr64_55() { unimplemented!("instr64_55") }
pub unsafe fn instr64_56() { unimplemented!("instr64_56") }
pub unsafe fn instr64_57() { unimplemented!("instr64_57") }
pub unsafe fn instr64_58() { unimplemented!("instr64_58") }
pub unsafe fn instr64_59() { unimplemented!("instr64_59") }
pub unsafe fn instr64_5A() { unimplemented!("instr64_5A") }
pub unsafe fn instr64_5B() { unimplemented!("instr64_5B") }
pub unsafe fn instr64_5C() { unimplemented!("instr64_5C") }
pub unsafe fn instr64_5D() { unimplemented!("instr64_5D") }
pub unsafe fn instr64_5E() { unimplemented!("instr64_5E") }
pub unsafe fn instr64_5F() { unimplemented!("instr64_5F") }
pub unsafe fn instr64_60() { unimplemented!("instr64_60") }
pub unsafe fn instr64_61() { unimplemented!("instr64_61") }
pub unsafe fn instr64_68(a0: i32) { unimplemented!("instr64_68") }
pub unsafe fn instr64_69_mem(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_69_mem") }
pub unsafe fn instr64_69_reg(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_69_reg") }
pub unsafe fn instr64_6A(a0: i32) { unimplemented!("instr64_6A") }
pub unsafe fn instr64_6B_mem(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_6B_mem") }
pub unsafe fn instr64_6B_reg(a0: i32, a1: i32, a2: i32) { unimplemented!("instr64_6B_reg") }
pub unsafe fn instr64_6D() { unimplemented!("instr64_6D") }
pub unsafe fn instr64_6F() { unimplemented!("instr64_6F") }
pub unsafe fn instr64_70(a0: i32) { unimplemented!("instr64_70") }
pub unsafe fn instr64_71(a0: i32) { unimplemented!("instr64_71") }
pub unsafe fn instr64_72(a0: i32) { unimplemented!("instr64_72") }
pub unsafe fn instr64_73(a0: i32) { unimplemented!("instr64_73") }
pub unsafe fn instr64_74(a0: i32) { unimplemented!("instr64_74") }
pub unsafe fn instr64_75(a0: i32) { unimplemented!("instr64_75") }
pub unsafe fn instr64_76(a0: i32) { unimplemented!("instr64_76") }
pub unsafe fn instr64_77(a0: i32) { unimplemented!("instr64_77") }
pub unsafe fn instr64_78(a0: i32) { unimplemented!("instr64_78") }
pub unsafe fn instr64_79(a0: i32) { unimplemented!("instr64_79") }
pub unsafe fn instr64_7A(a0: i32) { unimplemented!("instr64_7A") }
pub unsafe fn instr64_7B(a0: i32) { unimplemented!("instr64_7B") }
pub unsafe fn instr64_7C(a0: i32) { unimplemented!("instr64_7C") }
pub unsafe fn instr64_7D(a0: i32) { unimplemented!("instr64_7D") }
pub unsafe fn instr64_7E(a0: i32) { unimplemented!("instr64_7E") }
pub unsafe fn instr64_7F(a0: i32) { unimplemented!("instr64_7F") }
pub unsafe fn instr64_81_0_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_0_mem") }
pub unsafe fn instr64_81_0_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_0_reg") }
pub unsafe fn instr64_81_1_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_1_mem") }
pub unsafe fn instr64_81_1_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_1_reg") }
pub unsafe fn instr64_81_2_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_2_mem") }
pub unsafe fn instr64_81_2_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_2_reg") }
pub unsafe fn instr64_81_3_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_3_mem") }
pub unsafe fn instr64_81_3_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_3_reg") }
pub unsafe fn instr64_81_4_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_4_mem") }
pub unsafe fn instr64_81_4_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_4_reg") }
pub unsafe fn instr64_81_5_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_5_mem") }
pub unsafe fn instr64_81_5_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_5_reg") }
pub unsafe fn instr64_81_6_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_6_mem") }
pub unsafe fn instr64_81_6_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_6_reg") }
pub unsafe fn instr64_81_7_mem(a0: i32, a1: i32) { unimplemented!("instr64_81_7_mem") }
pub unsafe fn instr64_81_7_reg(a0: i32, a1: i32) { unimplemented!("instr64_81_7_reg") }
pub unsafe fn instr64_83_0_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_0_mem") }
pub unsafe fn instr64_83_0_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_0_reg") }
pub unsafe fn instr64_83_1_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_1_mem") }
pub unsafe fn instr64_83_1_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_1_reg") }
pub unsafe fn instr64_83_2_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_2_mem") }
pub unsafe fn instr64_83_2_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_2_reg") }
pub unsafe fn instr64_83_3_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_3_mem") }
pub unsafe fn instr64_83_3_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_3_reg") }
pub unsafe fn instr64_83_4_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_4_mem") }
pub unsafe fn instr64_83_4_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_4_reg") }
pub unsafe fn instr64_83_5_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_5_mem") }
pub unsafe fn instr64_83_5_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_5_reg") }
pub unsafe fn instr64_83_6_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_6_mem") }
pub unsafe fn instr64_83_6_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_6_reg") }
pub unsafe fn instr64_83_7_mem(a0: i32, a1: i32) { unimplemented!("instr64_83_7_mem") }
pub unsafe fn instr64_83_7_reg(a0: i32, a1: i32) { unimplemented!("instr64_83_7_reg") }
pub unsafe fn instr64_85_mem(a0: i32, a1: i32) { unimplemented!("instr64_85_mem") }
pub unsafe fn instr64_85_reg(a0: i32, a1: i32) { unimplemented!("instr64_85_reg") }
pub unsafe fn instr64_87_mem(a0: i32, a1: i32) { unimplemented!("instr64_87_mem") }
pub unsafe fn instr64_87_reg(a0: i32, a1: i32) { unimplemented!("instr64_87_reg") }
pub unsafe fn instr64_89_mem(a0: i32, a1: i32) { unimplemented!("instr64_89_mem") }
pub unsafe fn instr64_89_reg(a0: i32, a1: i32) { unimplemented!("instr64_89_reg") }
pub unsafe fn instr64_8B_mem(a0: i32, a1: i32) { unimplemented!("instr64_8B_mem") }
pub unsafe fn instr64_8B_reg(a0: i32, a1: i32) { unimplemented!("instr64_8B_reg") }
pub unsafe fn instr64_8C_mem(a0: i32, a1: i32) { unimplemented!("instr64_8C_mem") }
pub unsafe fn instr64_8C_reg(a0: i32, a1: i32) { unimplemented!("instr64_8C_reg") }
pub unsafe fn instr64_8D_mem(a0: i32, a1: i32) { unimplemented!("instr64_8D_mem") }
pub unsafe fn instr64_8D_reg(a0: i32, a1: i32) { unimplemented!("instr64_8D_reg") }
pub unsafe fn instr64_8F_0_mem(a0: i32) { unimplemented!("instr64_8F_0_mem") }
pub unsafe fn instr64_8F_0_reg(a0: i32) { unimplemented!("instr64_8F_0_reg") }
pub unsafe fn instr64_91() { unimplemented!("instr64_91") }
pub unsafe fn instr64_92() { unimplemented!("instr64_92") }
pub unsafe fn instr64_93() { unimplemented!("instr64_93") }
pub unsafe fn instr64_94() { unimplemented!("instr64_94") }
pub unsafe fn instr64_95() { unimplemented!("instr64_95") }
pub unsafe fn instr64_96() { unimplemented!("instr64_96") }
pub unsafe fn instr64_97() { unimplemented!("instr64_97") }
pub unsafe fn instr64_98() { unimplemented!("instr64_98") }
pub unsafe fn instr64_99() { unimplemented!("instr64_99") }
pub unsafe fn instr64_9A(a0: i32, a1: i32) { unimplemented!("instr64_9A") }
pub unsafe fn instr64_9C() { unimplemented!("instr64_9C") }
pub unsafe fn instr64_9D() { unimplemented!("instr64_9D") }
pub unsafe fn instr64_A1(a0: i32) { unimplemented!("instr64_A1") }
pub unsafe fn instr64_A3(a0: i32) { unimplemented!("instr64_A3") }
pub unsafe fn instr64_A5() { unimplemented!("instr64_A5") }
pub unsafe fn instr64_A7() { unimplemented!("instr64_A7") }
pub unsafe fn instr64_A9(a0: i32) { unimplemented!("instr64_A9") }
pub unsafe fn instr64_AB() { unimplemented!("instr64_AB") }
pub unsafe fn instr64_AD() { unimplemented!("instr64_AD") }
pub unsafe fn instr64_AF() { unimplemented!("instr64_AF") }
pub unsafe fn instr64_B8(a0: u64) { unimplemented!("instr64_B8") }
pub unsafe fn instr64_B9(a0: u64) { unimplemented!("instr64_B9") }
pub unsafe fn instr64_BA(a0: u64) { unimplemented!("instr64_BA") }
pub unsafe fn instr64_BB(a0: u64) { unimplemented!("instr64_BB") }
pub unsafe fn instr64_BC(a0: u64) { unimplemented!("instr64_BC") }
pub unsafe fn instr64_BD(a0: u64) { unimplemented!("instr64_BD") }
pub unsafe fn instr64_BE(a0: u64) { unimplemented!("instr64_BE") }
pub unsafe fn instr64_BF(a0: u64) { unimplemented!("instr64_BF") }
pub unsafe fn instr64_C1_0_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_0_mem") }
pub unsafe fn instr64_C1_0_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_0_reg") }
pub unsafe fn instr64_C1_1_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_1_mem") }
pub unsafe fn instr64_C1_1_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_1_reg") }
pub unsafe fn instr64_C1_2_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_2_mem") }
pub unsafe fn instr64_C1_2_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_2_reg") }
pub unsafe fn instr64_C1_3_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_3_mem") }
pub unsafe fn instr64_C1_3_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_3_reg") }
pub unsafe fn instr64_C1_4_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_4_mem") }
pub unsafe fn instr64_C1_4_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_4_reg") }
pub unsafe fn instr64_C1_5_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_5_mem") }
pub unsafe fn instr64_C1_5_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_5_reg") }
pub unsafe fn instr64_C1_6_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_6_mem") }
pub unsafe fn instr64_C1_6_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_6_reg") }
pub unsafe fn instr64_C1_7_mem(a0: i32, a1: i32) { unimplemented!("instr64_C1_7_mem") }
pub unsafe fn instr64_C1_7_reg(a0: i32, a1: i32) { unimplemented!("instr64_C1_7_reg") }
pub unsafe fn instr64_C2(a0: i32) { unimplemented!("instr64_C2") }
pub unsafe fn instr64_C3() { unimplemented!("instr64_C3") }
pub unsafe fn instr64_C4_mem(a0: i32, a1: i32) { unimplemented!("instr64_C4_mem") }
pub unsafe fn instr64_C4_reg(a0: i32, a1: i32) { unimplemented!("instr64_C4_reg") }
pub unsafe fn instr64_C5_mem(a0: i32, a1: i32) { unimplemented!("instr64_C5_mem") }
pub unsafe fn instr64_C5_reg(a0: i32, a1: i32) { unimplemented!("instr64_C5_reg") }
pub unsafe fn instr64_C7_0_mem(a0: i32, a1: i32) { unimplemented!("instr64_C7_0_mem") }
pub unsafe fn instr64_C7_0_reg(a0: i32, a1: i32) { unimplemented!("instr64_C7_0_reg") }
pub unsafe fn instr64_C8(a0: i32, a1: i32) { unimplemented!("instr64_C8") }
pub unsafe fn instr64_C9() { unimplemented!("instr64_C9") }
pub unsafe fn instr64_CA(a0: i32) { unimplemented!("instr64_CA") }
pub unsafe fn instr64_CB() { unimplemented!("instr64_CB") }
pub unsafe fn instr64_CF() { unimplemented!("instr64_CF") }
pub unsafe fn instr64_D1_0_mem(a0: i32) { unimplemented!("instr64_D1_0_mem") }
pub unsafe fn instr64_D1_0_reg(a0: i32) { unimplemented!("instr64_D1_0_reg") }
pub unsafe fn instr64_D1_1_mem(a0: i32) { unimplemented!("instr64_D1_1_mem") }
pub unsafe fn instr64_D1_1_reg(a0: i32) { unimplemented!("instr64_D1_1_reg") }
pub unsafe fn instr64_D1_2_mem(a0: i32) { unimplemented!("instr64_D1_2_mem") }
pub unsafe fn instr64_D1_2_reg(a0: i32) { unimplemented!("instr64_D1_2_reg") }
pub unsafe fn instr64_D1_3_mem(a0: i32) { unimplemented!("instr64_D1_3_mem") }
pub unsafe fn instr64_D1_3_reg(a0: i32) { unimplemented!("instr64_D1_3_reg") }
pub unsafe fn instr64_D1_4_mem(a0: i32) { unimplemented!("instr64_D1_4_mem") }
pub unsafe fn instr64_D1_4_reg(a0: i32) { unimplemented!("instr64_D1_4_reg") }
pub unsafe fn instr64_D1_5_mem(a0: i32) { unimplemented!("instr64_D1_5_mem") }
pub unsafe fn instr64_D1_5_reg(a0: i32) { unimplemented!("instr64_D1_5_reg") }
pub unsafe fn instr64_D1_6_mem(a0: i32) { unimplemented!("instr64_D1_6_mem") }
pub unsafe fn instr64_D1_6_reg(a0: i32) { unimplemented!("instr64_D1_6_reg") }
pub unsafe fn instr64_D1_7_mem(a0: i32) { unimplemented!("instr64_D1_7_mem") }
pub unsafe fn instr64_D1_7_reg(a0: i32) { unimplemented!("instr64_D1_7_reg") }
pub unsafe fn instr64_D3_0_mem(a0: i32) { unimplemented!("instr64_D3_0_mem") }
pub unsafe fn instr64_D3_0_reg(a0: i32) { unimplemented!("instr64_D3_0_reg") }
pub unsafe fn instr64_D3_1_mem(a0: i32) { unimplemented!("instr64_D3_1_mem") }
pub unsafe fn instr64_D3_1_reg(a0: i32) { unimplemented!("instr64_D3_1_reg") }
pub unsafe fn instr64_D3_2_mem(a0: i32) { unimplemented!("instr64_D3_2_mem") }
pub unsafe fn instr64_D3_2_reg(a0: i32) { unimplemented!("instr64_D3_2_reg") }
pub unsafe fn instr64_D3_3_mem(a0: i32) { unimplemented!("instr64_D3_3_mem") }
pub unsafe fn instr64_D3_3_reg(a0: i32) { unimplemented!("instr64_D3_3_reg") }
pub unsafe fn instr64_D3_4_mem(a0: i32) { unimplemented!("instr64_D3_4_mem") }
pub unsafe fn instr64_D3_4_reg(a0: i32) { unimplemented!("instr64_D3_4_reg") }
pub unsafe fn instr64_D3_5_mem(a0: i32) { unimplemented!("instr64_D3_5_mem") }
pub unsafe fn instr64_D3_5_reg(a0: i32) { unimplemented!("instr64_D3_5_reg") }
pub unsafe fn instr64_D3_6_mem(a0: i32) { unimplemented!("instr64_D3_6_mem") }
pub unsafe fn instr64_D3_6_reg(a0: i32) { unimplemented!("instr64_D3_6_reg") }
pub unsafe fn instr64_D3_7_mem(a0: i32) { unimplemented!("instr64_D3_7_mem") }
pub unsafe fn instr64_D3_7_reg(a0: i32) { unimplemented!("instr64_D3_7_reg") }
pub unsafe fn instr64_D9_0_mem(a0: i32) { unimplemented!("instr64_D9_0_mem") }
pub unsafe fn instr64_D9_0_reg(a0: i32) { unimplemented!("instr64_D9_0_reg") }
pub unsafe fn instr64_D9_1_mem(a0: i32) { unimplemented!("instr64_D9_1_mem") }
pub unsafe fn instr64_D9_1_reg(a0: i32) { unimplemented!("instr64_D9_1_reg") }
pub unsafe fn instr64_D9_2_mem(a0: i32) { unimplemented!("instr64_D9_2_mem") }
pub unsafe fn instr64_D9_2_reg(a0: i32) { unimplemented!("instr64_D9_2_reg") }
pub unsafe fn instr64_D9_3_mem(a0: i32) { unimplemented!("instr64_D9_3_mem") }
pub unsafe fn instr64_D9_3_reg(a0: i32) { unimplemented!("instr64_D9_3_reg") }
pub unsafe fn instr64_D9_4_mem(a0: i32) { unimplemented!("instr64_D9_4_mem") }
pub unsafe fn instr64_D9_4_reg(a0: i32) { unimplemented!("instr64_D9_4_reg") }
pub unsafe fn instr64_D9_5_mem(a0: i32) { unimplemented!("instr64_D9_5_mem") }
pub unsafe fn instr64_D9_5_reg(a0: i32) { unimplemented!("instr64_D9_5_reg") }
pub unsafe fn instr64_D9_6_mem(a0: i32) { unimplemented!("instr64_D9_6_mem") }
pub unsafe fn instr64_D9_6_reg(a0: i32) { unimplemented!("instr64_D9_6_reg") }
pub unsafe fn instr64_D9_7_mem(a0: i32) { unimplemented!("instr64_D9_7_mem") }
pub unsafe fn instr64_D9_7_reg(a0: i32) { unimplemented!("instr64_D9_7_reg") }
pub unsafe fn instr64_DD_0_mem(a0: i32) { unimplemented!("instr64_DD_0_mem") }
pub unsafe fn instr64_DD_0_reg(a0: i32) { unimplemented!("instr64_DD_0_reg") }
pub unsafe fn instr64_DD_1_mem(a0: i32) { unimplemented!("instr64_DD_1_mem") }
pub unsafe fn instr64_DD_1_reg(a0: i32) { unimplemented!("instr64_DD_1_reg") }
pub unsafe fn instr64_DD_2_mem(a0: i32) { unimplemented!("instr64_DD_2_mem") }
pub unsafe fn instr64_DD_2_reg(a0: i32) { unimplemented!("instr64_DD_2_reg") }
pub unsafe fn instr64_DD_3_mem(a0: i32) { unimplemented!("instr64_DD_3_mem") }
pub unsafe fn instr64_DD_3_reg(a0: i32) { unimplemented!("instr64_DD_3_reg") }
pub unsafe fn instr64_DD_4_mem(a0: i32) { unimplemented!("instr64_DD_4_mem") }
pub unsafe fn instr64_DD_4_reg(a0: i32) { unimplemented!("instr64_DD_4_reg") }
pub unsafe fn instr64_DD_5_mem(a0: i32) { unimplemented!("instr64_DD_5_mem") }
pub unsafe fn instr64_DD_5_reg(a0: i32) { unimplemented!("instr64_DD_5_reg") }
pub unsafe fn instr64_DD_6_mem(a0: i32) { unimplemented!("instr64_DD_6_mem") }
pub unsafe fn instr64_DD_6_reg(a0: i32) { unimplemented!("instr64_DD_6_reg") }
pub unsafe fn instr64_DD_7_mem(a0: i32) { unimplemented!("instr64_DD_7_mem") }
pub unsafe fn instr64_DD_7_reg(a0: i32) { unimplemented!("instr64_DD_7_reg") }
pub unsafe fn instr64_E0(a0: i32) { unimplemented!("instr64_E0") }
pub unsafe fn instr64_E1(a0: i32) { unimplemented!("instr64_E1") }
pub unsafe fn instr64_E2(a0: i32) { unimplemented!("instr64_E2") }
pub unsafe fn instr64_E3(a0: i32) { unimplemented!("instr64_E3") }
pub unsafe fn instr64_E5(a0: i32) { unimplemented!("instr64_E5") }
pub unsafe fn instr64_E7(a0: i32) { unimplemented!("instr64_E7") }
pub unsafe fn instr64_E8(a0: i32) { unimplemented!("instr64_E8") }
pub unsafe fn instr64_E9(a0: i32) { unimplemented!("instr64_E9") }
pub unsafe fn instr64_EA(a0: i32, a1: i32) { unimplemented!("instr64_EA") }
pub unsafe fn instr64_EB(a0: i32) { unimplemented!("instr64_EB") }
pub unsafe fn instr64_ED() { unimplemented!("instr64_ED") }
pub unsafe fn instr64_EF() { unimplemented!("instr64_EF") }
pub unsafe fn instr64_F26D() { unimplemented!("instr64_F26D") }
pub unsafe fn instr64_F26F() { unimplemented!("instr64_F26F") }
pub unsafe fn instr64_F2A5() { unimplemented!("instr64_F2A5") }
pub unsafe fn instr64_F2A7() { unimplemented!("instr64_F2A7") }
pub unsafe fn instr64_F2AB() { unimplemented!("instr64_F2AB") }
pub unsafe fn instr64_F2AD() { unimplemented!("instr64_F2AD") }
pub unsafe fn instr64_F2AF() { unimplemented!("instr64_F2AF") }
pub unsafe fn instr64_F30FB8_mem(a0: i32, a1: i32) { unimplemented!("instr64_F30FB8_mem") }
pub unsafe fn instr64_F30FB8_reg(a0: i32, a1: i32) { unimplemented!("instr64_F30FB8_reg") }
pub unsafe fn instr64_F36D() { unimplemented!("instr64_F36D") }
pub unsafe fn instr64_F36F() { unimplemented!("instr64_F36F") }
pub unsafe fn instr64_F3A5() { unimplemented!("instr64_F3A5") }
pub unsafe fn instr64_F3A7() { unimplemented!("instr64_F3A7") }
pub unsafe fn instr64_F3AB() { unimplemented!("instr64_F3AB") }
pub unsafe fn instr64_F3AD() { unimplemented!("instr64_F3AD") }
pub unsafe fn instr64_F3AF() { unimplemented!("instr64_F3AF") }
pub unsafe fn instr64_F7_0_mem(a0: i32, a1: i32) { unimplemented!("instr64_F7_0_mem") }
pub unsafe fn instr64_F7_0_reg(a0: i32, a1: i32) { unimplemented!("instr64_F7_0_reg") }
pub unsafe fn instr64_F7_1_mem(a0: i32, a1: i32) { unimplemented!("instr64_F7_1_mem") }
pub unsafe fn instr64_F7_1_reg(a0: i32, a1: i32) { unimplemented!("instr64_F7_1_reg") }
pub unsafe fn instr64_F7_2_mem(a0: i32) { unimplemented!("instr64_F7_2_mem") }
pub unsafe fn instr64_F7_2_reg(a0: i32) { unimplemented!("instr64_F7_2_reg") }
pub unsafe fn instr64_F7_3_mem(a0: i32) { unimplemented!("instr64_F7_3_mem") }
pub unsafe fn instr64_F7_3_reg(a0: i32) { unimplemented!("instr64_F7_3_reg") }
pub unsafe fn instr64_F7_4_mem(a0: i32) { unimplemented!("instr64_F7_4_mem") }
pub unsafe fn instr64_F7_4_reg(a0: i32) { unimplemented!("instr64_F7_4_reg") }
pub unsafe fn instr64_F7_5_mem(a0: i32) { unimplemented!("instr64_F7_5_mem") }
pub unsafe fn instr64_F7_5_reg(a0: i32) { unimplemented!("instr64_F7_5_reg") }
pub unsafe fn instr64_F7_6_mem(a0: i32) { unimplemented!("instr64_F7_6_mem") }
pub unsafe fn instr64_F7_6_reg(a0: i32) { unimplemented!("instr64_F7_6_reg") }
pub unsafe fn instr64_F7_7_mem(a0: i32) { unimplemented!("instr64_F7_7_mem") }
pub unsafe fn instr64_F7_7_reg(a0: i32) { unimplemented!("instr64_F7_7_reg") }
pub unsafe fn instr64_FF_0_mem(a0: i32) { unimplemented!("instr64_FF_0_mem") }
pub unsafe fn instr64_FF_0_reg(a0: i32) { unimplemented!("instr64_FF_0_reg") }
pub unsafe fn instr64_FF_1_mem(a0: i32) { unimplemented!("instr64_FF_1_mem") }
pub unsafe fn instr64_FF_1_reg(a0: i32) { unimplemented!("instr64_FF_1_reg") }
pub unsafe fn instr64_FF_2_mem(a0: i32) { unimplemented!("instr64_FF_2_mem") }
pub unsafe fn instr64_FF_2_reg(a0: i32) { unimplemented!("instr64_FF_2_reg") }
pub unsafe fn instr64_FF_3_mem(a0: i32) { unimplemented!("instr64_FF_3_mem") }
pub unsafe fn instr64_FF_3_reg(a0: i32) { unimplemented!("instr64_FF_3_reg") }
pub unsafe fn instr64_FF_4_mem(a0: i32) { unimplemented!("instr64_FF_4_mem") }
pub unsafe fn instr64_FF_4_reg(a0: i32) { unimplemented!("instr64_FF_4_reg") }
pub unsafe fn instr64_FF_5_mem(a0: i32) { unimplemented!("instr64_FF_5_mem") }
pub unsafe fn instr64_FF_5_reg(a0: i32) { unimplemented!("instr64_FF_5_reg") }
pub unsafe fn instr64_FF_6_mem(a0: i32) { unimplemented!("instr64_FF_6_mem") }
pub unsafe fn instr64_FF_6_reg(a0: i32) { unimplemented!("instr64_FF_6_reg") }
