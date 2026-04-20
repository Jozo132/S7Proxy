// PDU splitter/merger for large transfers
// S7 PDUs have a maximum negotiated size. Large read/write requests must be
// split into multiple PDUs and responses must be merged back.

import { S7_PROTOCOL_ID, S7_MSG_JOB, S7_FN_READ_VAR } from './constants';
import { ERR_NONE, setLastError } from './error';

/** Check if a data transfer needs splitting based on max PDU size. */
export function pdu_needsSplit(totalDataLen: u32, maxPduSize: u16): bool {
  // Overhead: TPKT(4) + COTP DT(3) + S7 header(10) + params(~14) = ~31 bytes
  const overhead: u32 = 31;
  const maxPayload = <u32>maxPduSize - overhead;
  return totalDataLen > maxPayload;
}

/** Calculate the maximum data payload per PDU given the PDU size limit. */
export function pdu_maxPayload(maxPduSize: u16): u32 {
  const overhead: u32 = 31;
  return <u32>maxPduSize - overhead;
}

/** Calculate how many chunks are needed for a given data length. */
export function pdu_chunkCount(totalDataLen: u32, maxPduSize: u16): u32 {
  const maxPayload = pdu_maxPayload(maxPduSize);
  if (maxPayload === 0) return 0;
  return (totalDataLen + maxPayload - 1) / maxPayload;
}
