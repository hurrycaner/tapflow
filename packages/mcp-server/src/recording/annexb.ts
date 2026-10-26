import {
  hasEnvelope,
  readEnvelopeFlags,
  HEADER_SIZE,
  CODEC_H264,
  CODEC_AUDIO,
  parseSpsDimensions,
} from '@tapflowio/agent-core/utils'

export interface FrameInfo {
  codec: 'h264' | 'jpeg' | 'audio'
  keyframe: boolean
  capturedAt: number
  payload: Buffer
  /** IDR carrying SPS and PPS: the only access unit a muxer may be primed on. h264 only. */
  decodableKey: boolean
  dims: { width: number; height: number } | null
}

/**
 * Splits Annex-B into NAL bodies (no start code). Subarrays, not copies: the recorder inspects every
 * frame and most are dropped or forwarded whole.
 */
export function splitNalUnits(payload: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  let start = -1 // first byte of the current NAL body
  for (let i = 0; i + 2 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0) continue
    const third = payload[i + 2]
    const codeLen = third === 1 ? 3 : third === 0 && payload[i + 3] === 1 ? 4 : 0
    if (codeLen === 0) continue
    if (start >= 0) nals.push(payload.subarray(start, trimEnd(payload, start, i)))
    start = i + codeLen
    i += codeLen - 1
  }
  if (start >= 0 && start < payload.length) nals.push(payload.subarray(start))
  return nals
}

// A 4-byte start code's leading zero, or trailing_zero_8bits, belongs to neither NAL.
function trimEnd(payload: Uint8Array, start: number, end: number): number {
  let e = end
  while (e > start && payload[e - 1] === 0) e--
  return e
}

export function nalType(nal: Uint8Array): number {
  return nal[0]! & 0x1f
}

/**
 * An access unit with IDR (5), SPS (7) and PPS (8). scrcpy's periodic IDRs carry no parameter sets, and a
 * muxer primed on one cannot configure its decoder, so the recorder waits for this rather than for the
 * envelope's keyframe flag alone.
 */
export function isDecodableKey(payload: Uint8Array): boolean {
  let idr = false
  let sps = false
  let pps = false
  for (const nal of splitNalUnits(payload)) {
    const t = nalType(nal)
    if (t === 5) idr = true
    else if (t === 7) sps = true
    else if (t === 8) pps = true
  }
  return idr && sps && pps
}

export function spsDimensions(payload: Uint8Array): { width: number; height: number } | null {
  for (const nal of splitNalUnits(payload)) {
    if (nalType(nal) === 7) return parseSpsDimensions(nal)
  }
  return null
}

/** Null when the frame has no TFFE envelope. */
export function inspectFrame(frame: Buffer): FrameInfo | null {
  if (!hasEnvelope(frame)) return null
  const flags = readEnvelopeFlags(frame)
  const payload = frame.subarray(HEADER_SIZE)
  const capturedAt = Number(frame.readBigUInt64BE(6))
  const codec = flags.codec === CODEC_AUDIO ? 'audio' : flags.codec === CODEC_H264 ? 'h264' : 'jpeg'
  const isH264 = flags.codec === CODEC_H264
  return {
    codec,
    keyframe: flags.keyframe,
    capturedAt,
    payload,
    decodableKey: isH264 && isDecodableKey(payload),
    dims: isH264 ? spsDimensions(payload) : null,
  }
}
