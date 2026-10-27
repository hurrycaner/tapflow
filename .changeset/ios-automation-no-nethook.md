---
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
---

Apps launched by the MCP server or the flow runner no longer get tapflow's network hook on iOS. SDKs with integrity checks, such as Plaid and Pinwheel, read the injected library as tampering and rendered a blank WebView; the relay now marks the launch as an automation session and the iOS agent clears `DYLD_INSERT_LIBRARIES` at boot and before each launch. The dashboard's offline toggle is unavailable on those sessions.
