import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "googlechat-gif";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Google Chat GIF",
  description: "Search Giphy and post an animated GIF into an allowlisted Google Chat space.",
  register() {
    // Tool registration added in a later task.
  },
});
