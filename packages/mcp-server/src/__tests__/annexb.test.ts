import { describe, it, expect } from 'vitest'
import { writeEnvelopeHeader, CODEC_H264, CODEC_JPEG, CODEC_AUDIO } from '@tapflowio/agent-core/utils'
import {
  splitNalUnits, nalType, isDecodableKey, spsDimensions, inspectFrame,
} from '../recording/annexb'

// 1280x720 baseline SPS (profile 66, level 3.1), hand-packed: 0x42 0xc0 0x1f, then
// ue(0) id, ue(0) log2_max_frame_num, ue(0) poc type, ue(0) log2_max_poc_lsb, ue(1) refs, gaps 0,
// ue(79) width MBs, ue(44) height MBs, frame_mbs_only 1, direct_8x8 1, no crop, no VUI.
function spsNal(): Uint8Array {
  const bits: number[] = []
  const u = (n: number, v: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1) }
  const ue = (v: number) => {
    const code = v + 1
    const len = Math.floor(Math.log2(code))
    for (let i = 0; i < len; i++) bits.push(0)
    u(len + 1, code)
  }
  u(8, 66); u(8, 0xc0); u(8, 31)
  ue(0); ue(0); ue(0); ue(0); ue(1); u(1, 0)
  ue(79); ue(44); u(1, 1); u(1, 1); u(1, 0); u(1, 0)
  while (bits.length % 8) bits.push(0)
  const out = [0x67]
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return new Uint8Array(out)
}

const SPS = spsNal()
const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80])
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21, 0xff])
const P = new Uint8Array([0x41, 0x9a, 0x24, 0x6c])

function annexb(...nals: Uint8Array[]): Uint8Array {
  return Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, 1]), n])))
}

function framed(payload: Uint8Array, opts: { codec: number; keyframe?: boolean }, at = 1_700_000_000_123): Buffer {
  return writeEnvelopeHeader(Buffer.from(payload), at, opts)
}

describe('annexb', () => {
  it('splits 4-byte start codes into bodies', () => {
    const nals = splitNalUnits(annexb(SPS, PPS, IDR))
    expect(nals.map(nalType)).toEqual([7, 8, 5])
    expect(Array.from(nals[1]!)).toEqual(Array.from(PPS))
    expect(Array.from(nals[2]!)).toEqual(Array.from(IDR))
  })

  it('splits 3-byte start codes', () => {
    const buf = Buffer.concat([Buffer.from([0, 0, 1]), SPS, Buffer.from([0, 0, 1]), PPS, Buffer.from([0, 0, 1]), IDR])
    expect(splitNalUnits(buf).map(nalType)).toEqual([7, 8, 5])
    expect(Array.from(splitNalUnits(buf)[2]!)).toEqual(Array.from(IDR))
  })

  it('returns subarrays that share the input buffer and nothing without a start code', () => {
    const buf = annexb(PPS)
    expect(splitNalUnits(buf)[0]!.buffer).toBe(buf.buffer)
    expect(splitNalUnits(new Uint8Array([0x65, 1, 2, 3]))).toEqual([])
  })

  it('IDR + SPS + PPS is a decodable key with parsed dimensions', () => {
    const payload = annexb(SPS, PPS, IDR)
    expect(isDecodableKey(payload)).toBe(true)
    expect(spsDimensions(payload)).toEqual({ width: 1280, height: 720 })
  })

  it('IDR without parameter sets (scrcpy periodic IDR) is not decodable', () => {
    const payload = annexb(IDR)
    expect(isDecodableKey(payload)).toBe(false)
    expect(spsDimensions(payload)).toBeNull()
  })

  it('SPS + PPS without an IDR is not decodable', () => {
    expect(isDecodableKey(annexb(SPS, PPS, P))).toBe(false)
  })

  it('IDR with SPS but no PPS is not decodable', () => {
    expect(isDecodableKey(annexb(SPS, IDR))).toBe(false)
  })

  it('spsDimensions is null for an unparsable SPS', () => {
    expect(spsDimensions(annexb(new Uint8Array([0x67, 0x42])))).toBeNull()
  })
})

describe('inspectFrame', () => {
  it('reads a keyframe with parameter sets', () => {
    const info = inspectFrame(framed(annexb(SPS, PPS, IDR), { codec: CODEC_H264, keyframe: true }))!
    expect(info.codec).toBe('h264')
    expect(info.keyframe).toBe(true)
    expect(info.decodableKey).toBe(true)
    expect(info.dims).toEqual({ width: 1280, height: 720 })
    expect(info.payload.length).toBe(annexb(SPS, PPS, IDR).length)
  })

  it('a P-frame is not a keyframe and not decodable', () => {
    const info = inspectFrame(framed(annexb(P), { codec: CODEC_H264, keyframe: false }))!
    expect(info.keyframe).toBe(false)
    expect(info.decodableKey).toBe(false)
    expect(info.dims).toBeNull()
  })

  it('a flagged keyframe whose IDR lacks SPS/PPS is not decodableKey', () => {
    const info = inspectFrame(framed(annexb(IDR), { codec: CODEC_H264, keyframe: true }))!
    expect(info.keyframe).toBe(true)
    expect(info.decodableKey).toBe(false)
  })

  it('round-trips capturedAt', () => {
    const info = inspectFrame(framed(annexb(SPS, PPS, IDR), { codec: CODEC_H264, keyframe: true }))!
    expect(info.capturedAt).toBe(1_700_000_000_123)
  })

  it('jpeg is never a decodable key and has no dims', () => {
    const info = inspectFrame(framed(annexb(SPS, PPS, IDR), { codec: CODEC_JPEG }))!
    expect(info.codec).toBe('jpeg')
    expect(info.decodableKey).toBe(false)
    expect(info.dims).toBeNull()
  })

  it('audio is classified as audio', () => {
    const info = inspectFrame(framed(new Uint8Array([1, 2, 3, 4]), { codec: CODEC_AUDIO }))!
    expect(info.codec).toBe('audio')
    expect(info.decodableKey).toBe(false)
  })

  it('returns null without the TFFE envelope', () => {
    expect(inspectFrame(Buffer.from(annexb(SPS, PPS, IDR)))).toBeNull()
    expect(inspectFrame(Buffer.alloc(30))).toBeNull()
  })
})
