// Shared constants for the service worker and the side panel (both load ES modules).
// offscreen.js and tab-ui.js are classic scripts and keep their own small constants.

// Saved in chrome.storage.local under "settings". Readers merge stored values over these.
export const DEFAULT_SETTINGS = {
  elevenKey: "",
  geminiKey: "",
  geminiModel: "gemini-3.8-flash",
  chunkSeconds: 45,        // batch transcription only
  autoGenerate: false,     // generate cards automatically when a capture finishes
  sttMode: "realtime"      // "realtime" (live WebSocket) or "batch" (timed WebM uploads)
};

export const DEFAULT_DECK = "Default";
export const DEFAULT_PROMPT = "Create concise flashcards covering the key facts and concepts.";

// Capture time limit (minutes) when the "Stop after…" option is chosen.
export const LIMIT_DEFAULT_MINUTES = 60;
export const LIMIT_MAX_MINUTES = 600;

// Session statuses. ACTIVE: a session is in progress. CAPTURING: audio is still being recorded
// (drives the REC badge, the Stop label, and the in-tab UI).
export const ACTIVE_STATUSES = ["starting", "recording", "transcribing"];
export const CAPTURING_STATUSES = ["starting", "recording"];
