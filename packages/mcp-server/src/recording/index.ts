import os from 'os'
import type { TapflowClient } from '../client.js'
import { Mp4Segment } from './mp4.js'
import { RecordingManager } from './RecordingManager.js'
import { RecordingUploader } from './uploader.js'

export interface RecordingDeps {
  manager: RecordingManager
  uploader: RecordingUploader
}

/** The one recording stack of a client: the manager is the client's recorder hooks, the uploader its lane. */
export function createRecording(client: TapflowClient): RecordingDeps {
  // The manager needs the lane and the lane reports into the manager, so the report closes over a late binding.
  // eslint-disable-next-line prefer-const
  let manager: RecordingManager
  const uploader = new RecordingUploader({
    tokens: client.tokens,
    httpBase: client.httpBase(),
    report: (recordingId, index, state) => manager.setUploadState(recordingId, index, state),
  })
  manager = new RecordingManager({ client, openSegment: Mp4Segment.open, tmpDir: os.tmpdir(), lane: uploader })
  client.setRecorderHooks(manager)
  return { manager, uploader }
}
