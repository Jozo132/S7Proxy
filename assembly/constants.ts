// S7Comm Protocol Constants (shared between AS and Node.js)

// ─── Area Identifiers ───
export const S7AreaPE: u8 = 0x81;  // Process Inputs
export const S7AreaPA: u8 = 0x82;  // Process Outputs
export const S7AreaMK: u8 = 0x83;  // Merkers
export const S7AreaDB: u8 = 0x84;  // Data Blocks
export const S7AreaCT: u8 = 0x1C;  // Counters
export const S7AreaTM: u8 = 0x1D;  // Timers

// ─── Word Lengths ───
export const S7WLBit: u8 = 0x01;
export const S7WLByte: u8 = 0x02;
export const S7WLChar: u8 = 0x03;
export const S7WLWord: u8 = 0x04;
export const S7WLInt: u8 = 0x05;
export const S7WLDWord: u8 = 0x06;
export const S7WLDInt: u8 = 0x07;
export const S7WLReal: u8 = 0x08;
export const S7WLCounter: u8 = 0x1C;
export const S7WLTimer: u8 = 0x1D;

// ─── Block Types ───
export const BlockOB: u8 = 0x38;
export const BlockDB: u8 = 0x41;
export const BlockSDB: u8 = 0x42;
export const BlockFC: u8 = 0x43;
export const BlockSFC: u8 = 0x44;
export const BlockFB: u8 = 0x45;
export const BlockSFB: u8 = 0x46;

// ─── Connection Types ───
export const CONNTYPE_PG: u8 = 0x01;
export const CONNTYPE_OP: u8 = 0x02;
export const CONNTYPE_BASIC: u8 = 0x03;

// ─── TPKT ───
export const TPKT_VERSION: u8 = 0x03;
export const TPKT_HEADER_SIZE: u8 = 4;

// ─── COTP PDU Types ───
export const COTP_CR: u8 = 0xE0;  // Connection Request
export const COTP_CC: u8 = 0xD0;  // Connection Confirm
export const COTP_DT: u8 = 0xF0;  // Data Transfer
export const COTP_DR: u8 = 0x80;  // Disconnect Request

// ─── COTP Parameter Codes ───
export const COTP_PARAM_TPDU_SIZE: u8 = 0xC0;
export const COTP_PARAM_SRC_TSAP: u8 = 0xC1;
export const COTP_PARAM_DST_TSAP: u8 = 0xC2;

// ─── S7Comm Protocol ───
export const S7_PROTOCOL_ID: u8 = 0x32;

// ─── S7 Message Types ───
export const S7_MSG_JOB: u8 = 0x01;
export const S7_MSG_ACK: u8 = 0x02;
export const S7_MSG_ACK_DATA: u8 = 0x03;
export const S7_MSG_USERDATA: u8 = 0x07;

// ─── S7 Function Codes ───
export const S7_FN_SETUP_COMM: u8 = 0xF0;
export const S7_FN_READ_VAR: u8 = 0x04;
export const S7_FN_WRITE_VAR: u8 = 0x05;
export const S7_FN_REQUEST_DOWNLOAD: u8 = 0x1A;
export const S7_FN_DOWNLOAD_BLOCK: u8 = 0x1B;
export const S7_FN_DOWNLOAD_ENDED: u8 = 0x1C;
export const S7_FN_START_UPLOAD: u8 = 0x1D;
export const S7_FN_UPLOAD: u8 = 0x1E;
export const S7_FN_END_UPLOAD: u8 = 0x1F;
export const S7_FN_PLC_CONTROL: u8 = 0x28;
export const S7_FN_PLC_STOP: u8 = 0x29;

// ─── S7 Transport Sizes (for read/write item encoding) ───
export const S7_TRANSPORT_SIZE_BIT: u8 = 0x01;
export const S7_TRANSPORT_SIZE_BYTE: u8 = 0x02;
export const S7_TRANSPORT_SIZE_INT: u8 = 0x05;
export const S7_TRANSPORT_SIZE_REAL: u8 = 0x08;

// ─── S7 Return Codes ───
export const S7_RESULT_OK: u8 = 0xFF;
export const S7_RESULT_HARDWARE_ERROR: u8 = 0x01;
export const S7_RESULT_ACCESS_DENIED: u8 = 0x03;
export const S7_RESULT_ADDRESS_OUT_OF_RANGE: u8 = 0x05;
export const S7_RESULT_DATA_TYPE_NOT_SUPPORTED: u8 = 0x06;
export const S7_RESULT_OBJECT_NOT_FOUND: u8 = 0x0A;

// ─── S7 Error Classes ───
export const S7_ERR_NO_ERROR: u8 = 0x00;
export const S7_ERR_APPLICATION: u8 = 0x81;
export const S7_ERR_OBJECT: u8 = 0x82;
export const S7_ERR_RESOURCE: u8 = 0x83;
export const S7_ERR_SERVICE: u8 = 0x84;
export const S7_ERR_SUPPLY: u8 = 0x85;

// ─── Memory Layout ───
export const RX_BUFFER_OFFSET: u32 = 0;
export const RX_BUFFER_SIZE: u32 = 65536;  // 64 KB
export const TX_BUFFER_OFFSET: u32 = 65536;
export const TX_BUFFER_SIZE: u32 = 65536;  // 64 KB
export const SCRATCH_OFFSET: u32 = 131072;
export const SCRATCH_SIZE: u32 = 16384;    // 16 KB

// ─── Limits ───
export const MAX_PDU_SIZE: u16 = 960;
export const MIN_PDU_SIZE: u16 = 240;
export const DEFAULT_PDU_SIZE: u16 = 480;
export const MAX_AMQ: u16 = 16;
export const DEFAULT_AMQ: u16 = 8;
