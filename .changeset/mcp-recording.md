---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/mcp-server": minor
"@tapflowio/agent-core": minor
---

The MCP tools `start_recording`, `stop_recording` and `recording_status` record the device screen to mp4 and file it in the build's Recordings tab. The relay gains `session:stream`, which lets a holder turn its stream on or off during a session, and lists `holder-stream` in `agents:listed.features`. The recordings upload route now accepts an API token with `builds:write` as well as a session cookie. The MCP server still joins sessions with `stream: false` (except on a re-join while a recording is active) and reads the stream only while it records. `@tapflowio/agent-core` exports `parseSpsDimensions`.
