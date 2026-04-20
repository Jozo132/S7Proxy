// WASM memory allocation helpers

import { RX_BUFFER_OFFSET, RX_BUFFER_SIZE, TX_BUFFER_OFFSET, TX_BUFFER_SIZE, SCRATCH_OFFSET, SCRATCH_SIZE } from './constants';

// Simple bump allocator for scratch area
let scratchPtr: u32 = SCRATCH_OFFSET;

export function scratchAlloc(size: u32): u32 {
  const ptr = scratchPtr;
  if (ptr + size > SCRATCH_OFFSET + SCRATCH_SIZE) {
    return 0; // OOM in scratch area
  }
  scratchPtr = ptr + size;
  return ptr;
}

export function scratchReset(): void {
  scratchPtr = SCRATCH_OFFSET;
}

export function getRxBufferOffset(): u32 {
  return RX_BUFFER_OFFSET;
}

export function getTxBufferOffset(): u32 {
  return TX_BUFFER_OFFSET;
}

export function getRxBufferSize(): u32 {
  return RX_BUFFER_SIZE;
}

export function getTxBufferSize(): u32 {
  return TX_BUFFER_SIZE;
}
