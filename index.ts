import type { PluginApi } from "openclaw";

// Minimal plugin wrapper that just ships skills via openclaw.plugin.json.
// Runtime registration is intentionally empty.
export default function register(_api: PluginApi) {
  // no-op
}
