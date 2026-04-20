// Ring buffer for WASM ↔ Node.js data exchange

export class RingBuffer {
  private baseOffset: u32;
  private capacity: u32;
  private writePos: u32;
  private readPos: u32;

  constructor(baseOffset: u32, capacity: u32) {
    this.baseOffset = baseOffset;
    this.capacity = capacity;
    this.writePos = 0;
    this.readPos = 0;
  }

  get available(): u32 {
    return this.writePos >= this.readPos
      ? this.writePos - this.readPos
      : this.capacity - this.readPos + this.writePos;
  }

  get freeSpace(): u32 {
    return this.capacity - this.available - 1;
  }

  write(srcPtr: usize, len: u32): bool {
    if (len > this.freeSpace) return false;

    const dstBase = this.baseOffset;
    const cap = this.capacity;
    let wp = this.writePos;

    for (let i: u32 = 0; i < len; i++) {
      store<u8>(dstBase + wp, load<u8>(srcPtr + i));
      wp = (wp + 1) % cap;
    }

    this.writePos = wp;
    return true;
  }

  read(dstPtr: usize, len: u32): u32 {
    const avail = this.available;
    const toRead = len < avail ? len : avail;
    if (toRead === 0) return 0;

    const srcBase = this.baseOffset;
    const cap = this.capacity;
    let rp = this.readPos;

    for (let i: u32 = 0; i < toRead; i++) {
      store<u8>(dstPtr + i, load<u8>(srcBase + rp));
      rp = (rp + 1) % cap;
    }

    this.readPos = rp;
    return toRead;
  }

  peek(dstPtr: usize, len: u32): u32 {
    const avail = this.available;
    const toRead = len < avail ? len : avail;
    if (toRead === 0) return 0;

    const srcBase = this.baseOffset;
    const cap = this.capacity;
    let rp = this.readPos;

    for (let i: u32 = 0; i < toRead; i++) {
      store<u8>(dstPtr + i, load<u8>(srcBase + rp));
      rp = (rp + 1) % cap;
    }

    return toRead;
  }

  reset(): void {
    this.writePos = 0;
    this.readPos = 0;
  }

  getBaseOffset(): u32 {
    return this.baseOffset;
  }

  getCapacity(): u32 {
    return this.capacity;
  }
}
