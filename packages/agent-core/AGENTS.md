---
type: rules
topics: [agent-core, interface, design]
status: living
---

# agent-core — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

Defines the `DeviceAgent` interface and `AgentRegistry`.
The sole contract that platform implementations (ios-agent, android-agent) depend on.

## HOW

- The interface contains only platform-neutral methods every platform can implement — see `DeviceAgent` in `src/` for the current list.
- `queryUITree` returns the unified `UIElement[]` schema (`role`/`label`/`identifier`/`placeholder`/`frame`/`enabled`/`rawRole`); frames are normalized 0-1 in the same coordinate space the touch path consumes. Platform backends (uiautomator, AXUIElement, …) map into this schema on the agent side — relay and mcp-server are pass-through.
- `AgentRegistry`: platforms self-register via `register(platform, AgentClass, opts?)` (with a `connect` hook and optional `canRun` gate); the CLI drives them through `available()` / `connect(platform, relayUrl, opts)`. `connect`'s `AgentConnectOpts` carries `deviceFilter`, an optional `token` (opaque credential the agent forwards to a remote relay as `Authorization: Bearer`) and `lean` (`agent.lean` in the config; a platform with no lean technique ignores it).
- Interface changes must pass all implementation package tests before merging.

## HOW NOT

- Do not put platform-specific types (xcrun responses, ADB output, etc.) in this package.
- Do not add platform-specific methods to the `DeviceAgent` interface.
- Runtime dependencies are allowed only in shared implementation utils (`src/utils/`). Interface and registry code must have zero dependencies.
- Do not run a child process synchronously (`spawnSync`, `execFileSync`) in anything an agent calls repeatedly. It stops the loop that forwards every frame and touch: [agent-event-loop-blocking.md](../../contributing/agent-event-loop-blocking.md).

## Directory Structure

- `src/` — `DeviceAgent` interface, `AgentRegistry`, shared types, `createLogger` (leveled console logger), and the **optional capability interfaces** an agent implements alongside `DeviceAgent` rather than inside it: `NetworkControlCapability` and `PosturableCapability` (a foldable's screens), each feature-detected by its own predicate. (`AudioStreamCapability` was a third and is gone — nothing implemented it, nothing detected it, and audio ships through the agents' own per-session streamers.) That split is what the first **HOW** rule and the second **HOW NOT** rule require between them — the root [AGENTS.md](../../AGENTS.md)'s ISP entry names the principle. A platform that cannot do one of these implements neither the interface nor a stub, and advertises the capability string instead.
- `src/utils/` — shared implementation utils for ios-agent, android-agent, and the relay; not exposed through the `DeviceAgent` interface. Non-obvious ones in `stream.ts`: `disableNagle` (TCP_NODELAY — kills the ~40ms Nagle/delayed-ACK stall on small LAN writes) and `createKeyframeAwareSender` (drop-to-keyframe — why: relay AGENTS.md § Compound).
