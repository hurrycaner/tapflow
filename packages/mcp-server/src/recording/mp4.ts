// mediabunny 1.62.1 API this file relies on (node_modules/mediabunny/dist/mediabunny.d.ts):
//   :1646 EncodedPacket(data, type 'key'|'delta', timestamp s, duration s)
//   :1826 EncodedVideoPacketSource(codec) / :1839 add(packet, meta?: EncodedVideoChunkMetadata)
//   :1917 FilePathTarget(filePath)
//   :3067 IsobmffOutputFormatOptions.fastStart = false | 'in-memory' | 'reserve' | 'fragmented'
//   :3569 Mp4OutputFormat(options?)
//   :3714 Output: addVideoTrack(source), start(), finalize(), cancel()
import { open as openFile, stat } from 'node:fs/promises'
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  FilePathTarget,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { splitNalUnits, nalType, type FrameInfo } from './annexb.js'

/**
 * Bound on bytes waiting for the file write. Past it the disk is slower than the stream, and queueing
 * further would grow the heap without limit inside a long-lived MCP server; frames are dropped until the
 * next key so what reaches the file still decodes.
 */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024

/** Duration of a lone packet, and of the last one when the final delta is unknowable. */
const DEFAULT_FRAME_SECONDS = 1 / 30

export class NotPrimedError extends Error {
  constructor(message = 'first packet is not a decodable key (IDR + SPS + PPS)') {
    super(message)
    this.name = 'NotPrimedError'
  }
}

export interface SegmentResult {
  path: string
  bytes: number
  durationMs: number
  width: number
  height: number
  packets: number
  dropped: number
}

type PacketMeta = NonNullable<Parameters<EncodedVideoPacketSource['add']>[1]>

interface Held {
  data: Uint8Array
  type: 'key' | 'delta'
  ts: number
}

/** `avc1.PPCCLL` from SPS bytes 1-3 (nal[0] is the NAL header), per ISO/IEC 14496-15 avcC. */
function avcCodecString(sps: Uint8Array): string {
  const hex = (b: number | undefined) => (b ?? 0).toString(16).padStart(2, '0')
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

export class Mp4Segment {
  private readonly source = new EncodedVideoPacketSource('avc')
  private tail: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private firstCapturedAt: number | null = null
  private config: { meta: PacketMeta; width: number; height: number } | null = null
  private held: Held | null = null
  private lastTs = 0
  private lastDuration = DEFAULT_FRAME_SECONDS
  private awaitingKey = false
  private notPrimed: NotPrimedError | null = null
  private finalizing: Promise<SegmentResult> | null = null
  private error: unknown = null
  private packetCount = 0
  dropped = 0

  private constructor(
    readonly path: string,
    private readonly output: Output,
  ) {}

  /** Rejects on an unwritable path, so the recorder learns before it toggles the stream (C4). */
  static async open(path: string): Promise<Mp4Segment> {
    // Observed on 1.62.1: output.start() does not open the file (FilePathTarget opens lazily, R8's `?`), so
    // an unwritable path would only surface at the first add. Probe it here to keep C4's fail-before-toggle.
    await (await openFile(path, 'a')).close()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new FilePathTarget(path),
    })
    const segment = new Mp4Segment(path, output)
    output.addVideoTrack(segment.source)
    try {
      await output.start()
    } catch (e) {
      await output.cancel().catch(() => undefined)
      throw e
    }
    return segment
  }

  /** Synchronous and never throws: it runs inside the websocket message handler (V29). Returns false after a write error. */
  add(frame: FrameInfo): boolean {
    try {
      this.addUnsafe(frame)
    } catch (e) {
      this.error ??= e
    }
    // False once any write failed, so the caller can stop feeding a segment that finalize will reject anyway.
    return this.error === null
  }

  private addUnsafe(frame: FrameInfo): void {
    if (this.error || this.finalizing) return
    const key = frame.decodableKey || frame.keyframe

    if (this.config === null) {
      // Defense in depth: the recorder gates priming already.
      if (!frame.decodableKey || frame.dims === null) {
        this.notPrimed ??= new NotPrimedError()
        return
      }
      const sps = splitNalUnits(frame.payload).find((n) => nalType(n) === 7)
      if (!sps) {
        this.notPrimed ??= new NotPrimedError()
        return
      }
      this.config = {
        // description stays undefined so mediabunny derives avcC from the in-band SPS/PPS (R8).
        meta: {
          decoderConfig: {
            codec: avcCodecString(sps),
            codedWidth: frame.dims.width,
            codedHeight: frame.dims.height,
          },
        },
        width: frame.dims.width,
        height: frame.dims.height,
      }
      this.firstCapturedAt = frame.capturedAt
    }

    if (this.queuedBytes > MAX_QUEUED_BYTES) this.awaitingKey = true
    if (this.awaitingKey) {
      if (!key || this.queuedBytes > MAX_QUEUED_BYTES) {
        this.dropped++
        return
      }
      this.awaitingKey = false
    }

    // Clamp: the wall clock can step backwards, and muxers need non-decreasing timestamps (V4).
    const raw = (frame.capturedAt - (this.firstCapturedAt ?? frame.capturedAt)) / 1000
    const ts = Math.max(this.held?.ts ?? 0, raw, 0)
    if (this.held) this.emit(this.held, ts - this.held.ts)
    this.held = { data: frame.payload, type: key ? 'key' : 'delta', ts }
  }

  // A packet's duration is the gap to the next one, so each is held back until its successor shows up.
  private emit(h: Held, duration: number): void {
    this.lastTs = h.ts
    this.lastDuration = duration
    this.packetCount++
    const meta = this.packetCount === 1 ? this.config?.meta : undefined
    const packet = new EncodedPacket(h.data, h.type, h.ts, duration)
    this.queuedBytes += h.data.byteLength
    this.tail = this.tail.then(async () => {
      try {
        if (!this.error) await this.source.add(packet, meta)
      } catch (e) {
        this.error ??= e
      } finally {
        this.queuedBytes -= h.data.byteLength
      }
    })
  }

  /** Idempotent (V17): every call returns the same promise. */
  finalize(): Promise<SegmentResult> {
    if (!this.finalizing) {
      this.finalizing = this.doFinalize()
      // A caller that never awaits must not turn a write error into an unhandled rejection.
      this.finalizing.catch(() => undefined)
    }
    return this.finalizing
  }

  private async doFinalize(): Promise<SegmentResult> {
    try {
      if (this.held) {
        const h = this.held
        this.held = null
        this.emit(h, this.packetCount === 0 ? DEFAULT_FRAME_SECONDS : this.lastDuration)
      }
      await this.tail
      if (this.error) throw this.error
      if (this.packetCount === 0 || this.config === null) {
        // Pinned: an unprimed segment is an error, not an empty file the recorder would upload.
        throw this.notPrimed ?? new NotPrimedError('segment finalized with no packets')
      }
      await this.output.finalize()
      const { size } = await stat(this.path)
      return {
        path: this.path,
        bytes: size,
        durationMs: Math.round(this.lastTs * 1000 + this.lastDuration * 1000),
        width: this.config.width,
        height: this.config.height,
        packets: this.packetCount,
        dropped: this.dropped,
      }
    } catch (e) {
      await this.output.cancel().catch(() => undefined)
      throw e
    }
  }
}
