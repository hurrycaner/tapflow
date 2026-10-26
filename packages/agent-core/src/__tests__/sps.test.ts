import { describe, it, expect } from 'vitest'
import {
  parseSpsVui,
  parseSpsDimensions,
  rewriteSpsLowLatency,
  rewriteLowLatencySpsInFrame,
} from '../utils/sps.js'

// Mirror of the parser's Exp-Golomb encoding, to build controlled SPS fixtures.
class BitWriter {
  private bits: number[] = []
  bit(b: number) { this.bits.push(b & 1) }
  bitsN(val: number, n: number) { for (let i = n - 1; i >= 0; i--) this.bit((val >> i) & 1) }
  ue(val: number) {
    const code = val + 1
    const len = Math.floor(Math.log2(code))
    for (let i = 0; i < len; i++) this.bit(0)
    for (let i = len; i >= 0; i--) this.bit((code >> i) & 1)
  }
  /** Prepend the NAL header byte (0x67 = SPS) and pack to bytes. */
  toNal(): Uint8Array {
    const out = [0x67]
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0)
      out.push(b)
    }
    return new Uint8Array(out)
  }
}

// Baseline SPS (Level 5.0) with VUI present but no bitstream_restriction — the
// real iPhone VideoToolbox case.
function vuiNoRestrictionSps(numRef: number): Uint8Array {
  const w = new BitWriter()
  w.bitsN(66, 8); w.bitsN(0, 8); w.bitsN(50, 8) // profile / constraints / level 5.0
  w.ue(0)                 // sps_id
  w.ue(0)                 // log2_max_frame_num_minus4
  w.ue(0); w.ue(0)        // poc type 0 + log2_max_poc_lsb
  w.ue(numRef)            // max_num_ref_frames
  w.bit(0)                // gaps
  w.ue(10); w.ue(10)      // width/height in MBs
  w.bit(1); w.bit(1); w.bit(0) // frame_mbs_only / direct_8x8 / no cropping
  w.bit(1)                // vui present
  w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0) // sub-flags off
  w.bit(0)                // bitstream_restriction_flag = 0
  return w.toNal()
}

function annexB(start: number[], ...nals: Uint8Array[]): Uint8Array {
  const parts: number[] = []
  for (const n of nals) { parts.push(...start); parts.push(...n) }
  return new Uint8Array(parts)
}
const FOUR = [0, 0, 0, 1]
const THREE = [0, 0, 1]
// Split 4-byte-start-code Annex B back into NAL units (no start codes).
function splitFourByte(buf: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  let i = 0
  while (i + 4 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      let j = i + 4
      while (j + 4 <= buf.length && !(buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 0 && buf[j + 3] === 1)) j++
      nals.push(buf.subarray(i + 4, j + 4 <= buf.length ? j : buf.length))
      i = j
    } else i++
  }
  return nals
}

describe('rewriteSpsLowLatency (agent-core)', () => {
  it('injects reorder=0 / dpb=num_ref, re-parseable and level preserved', () => {
    const out = rewriteSpsLowLatency(vuiNoRestrictionSps(1))
    expect(out).not.toBeNull()
    const info = parseSpsVui(out!)
    expect(info.levelIdc).toBe(50)
    expect(info.profileIdc).toBe(66)
    expect(info.bitstreamRestriction).toBe(true)
    expect(info.maxNumReorderFrames).toBe(0)
    expect(info.maxDecFrameBuffering).toBe(1)
  })

  it('returns null when there is no VUI to extend', () => {
    const w = new BitWriter()
    w.bitsN(66, 8); w.bitsN(0, 8); w.bitsN(31, 8)
    w.ue(0); w.ue(0); w.ue(0); w.ue(0); w.ue(1); w.bit(0); w.ue(10); w.ue(10)
    w.bit(1); w.bit(1); w.bit(0)
    w.bit(0) // vui present = 0
    expect(rewriteSpsLowLatency(w.toNal())).toBeNull()
  })

  it('preserves the original NAL header byte (nal_ref_idc != 3)', () => {
    const sps = vuiNoRestrictionSps(1)
    sps[0] = 0x47 // nal_ref_idc=2, type=7 — still an SPS, not 0x67
    expect(rewriteSpsLowLatency(sps)![0]).toBe(0x47)
  })
})

describe('rewriteLowLatencySpsInFrame (agent-core)', () => {
  const PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80])
  const IDR = new Uint8Array([0x65, 0x11, 0x22, 0x33])

  it.each([
    ['4-byte start codes', FOUR],
    ['3-byte start codes', THREE],
  ])('rewrites the SPS and preserves PPS / IDR NALs (%s)', (_label, start) => {
    const frame = annexB(start, vuiNoRestrictionSps(1), PPS, IDR)
    const out = rewriteLowLatencySpsInFrame(frame)
    expect(out).not.toBe(frame) // changed

    const nals = splitFourByte(out) // output is always reassembled with 4-byte codes
    expect(nals).toHaveLength(3)
    // SPS now declares reorder=0
    const info = parseSpsVui(nals[0])
    expect(info.bitstreamRestriction).toBe(true)
    expect(info.maxNumReorderFrames).toBe(0)
    // PPS and IDR untouched
    expect(Array.from(nals[1])).toEqual(Array.from(PPS))
    expect(Array.from(nals[2])).toEqual(Array.from(IDR))
  })

  it('returns the same reference for a frame with no SPS (P-frame, zero-cost)', () => {
    const frame = annexB(FOUR, IDR) // VCL only, no SPS
    expect(rewriteLowLatencySpsInFrame(frame)).toBe(frame)
  })

  it('leaves a frame whose SPS already declares restriction unchanged', () => {
    const restricted = rewriteSpsLowLatency(vuiNoRestrictionSps(1))!
    const frame = annexB(FOUR, restricted, PPS, IDR)
    expect(rewriteLowLatencySpsInFrame(frame)).toBe(frame)
  })
})

// Independent writer of the dimension fields (same layout the android-agent tests use), so the
// asserted sizes come from the values encoded here rather than from re-running the parser.
function dimsSps(opts: {
  profile?: number; chroma?: number; wMbs: number; hUnits: number
  frameMbsOnly?: boolean; crop?: [number, number, number, number]
}): Uint8Array {
  const w = new BitWriter()
  const profile = opts.profile ?? 66
  w.bitsN(profile, 8); w.bitsN(0xc0, 8); w.bitsN(31, 8)
  w.ue(0)
  if (profile === 100) {
    w.ue(opts.chroma ?? 1)
    if (opts.chroma === 3) w.bit(0)
    w.ue(0); w.ue(0); w.bit(0); w.bit(0) // bit depths, bypass flag, no scaling matrix
  }
  w.ue(0); w.ue(0); w.ue(0) // log2_max_frame_num, poc type 0, log2_max_poc_lsb
  w.ue(1); w.bit(0)         // max_num_ref_frames, gaps
  w.ue(opts.wMbs - 1); w.ue(opts.hUnits - 1)
  const only = opts.frameMbsOnly ?? true
  w.bit(only ? 1 : 0)
  if (!only) w.bit(0)
  w.bit(1) // direct_8x8_inference
  if (opts.crop) { w.bit(1); for (const c of opts.crop) w.ue(c) } else w.bit(0)
  w.bit(0) // no VUI
  return w.toNal()
}

describe('parseSpsDimensions', () => {
  it('reads 1280x720 from a baseline SPS without cropping', () => {
    expect(parseSpsDimensions(dimsSps({ wMbs: 80, hUnits: 45 }))).toEqual({ width: 1280, height: 720 })
  })

  it('applies 4:2:0 cropping: 1080 rows displayed from 1088 coded (high profile)', () => {
    const sps = dimsSps({ profile: 100, chroma: 1, wMbs: 120, hUnits: 68, crop: [0, 0, 0, 4] })
    expect(parseSpsDimensions(sps)).toEqual({ width: 1920, height: 1080 })
  })

  it('crops 4:4:4 in single samples and interlaced in doubled rows', () => {
    expect(parseSpsDimensions(dimsSps({ profile: 100, chroma: 3, wMbs: 120, hUnits: 68, crop: [0, 0, 0, 8] })))
      .toEqual({ width: 1920, height: 1080 })
    // frame_mbs_only=0: 34 map units = 68 MB rows = 1088 rows; crop unit is 2*SubHeightC = 4 rows
    expect(parseSpsDimensions(dimsSps({ wMbs: 120, hUnits: 34, frameMbsOnly: false, crop: [0, 0, 0, 2] })))
      .toEqual({ width: 1920, height: 1080 })
  })

  it('accepts a leading 3- or 4-byte start code', () => {
    const sps = dimsSps({ wMbs: 80, hUnits: 45 })
    expect(parseSpsDimensions(annexB(FOUR, sps))).toEqual({ width: 1280, height: 720 })
    expect(parseSpsDimensions(annexB(THREE, sps))).toEqual({ width: 1280, height: 720 })
  })

  it('reads the existing VUI fixture (11 MBs = 176x176)', () => {
    expect(parseSpsDimensions(vuiNoRestrictionSps(1))).toEqual({ width: 176, height: 176 })
  })

  it('returns null for a non-SPS NAL and for a truncated SPS', () => {
    expect(parseSpsDimensions(new Uint8Array([0x41, 0x9a, 0x00]))).toBeNull()
    expect(parseSpsDimensions(new Uint8Array([0x67]))).toBeNull()
  })
})
