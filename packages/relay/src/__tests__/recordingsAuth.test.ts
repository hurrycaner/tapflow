import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { signJwt, hashPat } from '../middleware/auth'

// The recordings upload takes a cookie of any role or a PAT with `builds:write` (the MCP server's path),
// and `assertCanWrite` is deliberately not applied.

describe('POST /api/v1/recordings/upload auth', () => {
  let tmpDir: string
  let server: RelayServer | null = null
  let port: number
  const cookieFor = (userId: number, role: string) =>
    `tapflow_token=${signJwt({ userId, email: `u${userId}@example.test`, role: role as 'Admin' })}`

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-recauth-'))
    initDb(path.join(tmpDir, 'test.db'))
    const ins = getDb().prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)')
    ins.run(1, 'u1@example.test', 'Admin', 'x')
    ins.run(2, 'u2@example.test', 'Viewer', 'x')
    for (const [raw, scope] of [['tflw_pat_rec_ok', 'view,builds:write'], ['tflw_pat_rec_noscope', 'view']] as const) {
      getDb().prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
        .run(2, raw, hashPat(raw), scope)
    }
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })
  afterEach(async () => { await server?.stop(); server = null })

  async function upload(headers: Record<string, string>) {
    server = new RelayServer({ port: 0, uploadsDir: path.join(tmpDir, 'uploads') })
    await server.start()
    port = (server.address() as { port: number }).port
    const form = new FormData()
    form.append('file', new Blob(['mp4bytes'], { type: 'video/mp4' }), 'r.mp4')
    return fetch(`http://127.0.0.1:${port}/api/v1/recordings/upload?sessionId=s1`, { method: 'POST', headers, body: form })
  }
  const lastUploader = () =>
    (getDb().prepare('SELECT uploader_id FROM recordings ORDER BY id DESC LIMIT 1').get() as { uploader_id: number }).uploader_id

  it('accepts a PAT with builds:write and records its owner as the uploader', async () => {
    const res = await upload({ Authorization: 'Bearer tflw_pat_rec_ok' })
    expect(res.status).toBe(200)
    expect(lastUploader()).toBe(2)
  })

  it('refuses a PAT without builds:write', async () => {
    expect((await upload({ Authorization: 'Bearer tflw_pat_rec_noscope' })).status).toBe(403)
  })

  it('accepts a Viewer\'s cookie, as the dashboard does today', async () => {
    expect((await upload({ Cookie: cookieFor(2, 'Viewer') })).status).toBe(200)
  })

  it('refuses a request with no credential', async () => {
    expect((await upload({})).status).toBe(401)
  })
})
