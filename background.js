// Anki Capture service worker.
//
// Owns all session and transcript state in chrome.storage.local, starts and stops captures
// (the offscreen document does the actual recording and transcription), runs Gemini card
// generation, and handles the toolbar icon, context menu, keyboard shortcut, and messages.
// See spec.md for the full design.

import { generateCards } from "./lib/gemini.js";
import {
  DEFAULT_SETTINGS, DEFAULT_DECK, LIMIT_MAX_MINUTES, ACTIVE_STATUSES, CAPTURING_STATUSES
} from "./lib/config.js";

const MENU_ID = "anki-capture-toggle";
const STALE_MS = 15000; // no recorder heartbeat for this long = the capture is dead
const iso = () => new Date().toISOString();
const isActive = (s, id) => !!s && s.id === id && ACTIVE_STATUSES.includes(s.status);
const isCapturing = (s) => !!s && CAPTURING_STATUSES.includes(s.status);

// API keys live in storage.local, which content scripts can read by default. tab-ui.js runs inside
// arbitrary web pages, so restrict storage.local to the extension's own pages and workers.
// Runs at top level so it is applied every time the service worker starts.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((e) => console.warn("[Anki Capture] Could not restrict storage access:", e.message));

// ---- Session state
// Every read and write of `session` goes through one promise chain, so concurrent messages
// (heartbeats, transcript chunks, media reports) can't overwrite each other's updates.
// fn returns the next session, or undefined to leave it unchanged.

let sessionChain = Promise.resolve();
function patchSession(fn) {
  const p = sessionChain.then(async () => {
    const { session } = await chrome.storage.local.get("session");
    const next = fn(session || null);
    if (next === undefined) return session || null;
    await chrome.storage.local.set({ session: next });
    syncUi(next);
    return next;
  });
  sessionChain = p.catch(() => {});
  return p;
}
const getSession = () => patchSession(() => undefined);

// REC badge and context-menu title follow the session. Callback form so it also works on Chrome
// versions where contextMenus.update doesn't return a promise; a missing menu is ignored.
function syncUi(s) {
  const cap = isCapturing(s);
  chrome.action.setBadgeText({ text: cap ? "REC" : "" });
  chrome.contextMenus.update(MENU_ID, { title: cap ? "Stop Anki Capture" : "Start Anki Capture" },
    () => void chrome.runtime.lastError);
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch {}
}

// Committed text plus any realtime partial that was never committed.
const fullText = (s) => [s.transcript, s.partial].filter(Boolean).join(" ").trim();

// ---- Saved transcripts
// Saves (capture end) and deletes (side panel) run one at a time on their own chain.

let transcriptChain = Promise.resolve();
function patchTranscripts(fn) {
  const p = transcriptChain.then(async () => {
    const { transcripts = {} } = await chrome.storage.local.get("transcripts");
    fn(transcripts);
    await chrome.storage.local.set({ transcripts });
  });
  transcriptChain = p.catch(() => {});
  return p;
}

const saveTranscript = (s) =>
  patchTranscripts((t) => { t[s.id] = { text: fullText(s), createdAt: iso(), prompt: s.prompt }; });

async function deleteTranscript({ id }) {
  if (!id) throw new Error("No transcript selected.");
  await patchTranscripts((t) => { delete t[id]; });
}

// ---- Failure and stale-session recovery

// Ends an active session with an error, keeping whatever transcript was captured.
async function failSession(msg) {
  const s = await getSession();
  if (!s || !ACTIVE_STATUSES.includes(s.status)) return;
  await closeOffscreen();
  if (fullText(s)) await saveTranscript(s);
  await patchSession((x) => (x && x.id === s.id ? { ...x, status: "error", error: msg } : undefined));
}

// An active session whose recorder is gone (no offscreen document, or no recent heartbeat) is failed
// instead of staying "recording" forever. Runs before starts, on menu clicks, and on GET_STATE.
async function refreshStale() {
  const s = await getSession();
  if (!s || !ACTIVE_STATUSES.includes(s.status)) return s;
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  const age = Date.now() - Date.parse(s.lastHeartbeat || s.startedAt);
  if (!ctxs.length || age > STALE_MS) {
    await failSession("Capture stopped because the audio recorder is no longer active.");
    return getSession();
  }
  return s;
}

// ---- Capture

const NOT_INVOKED = "Chrome only lets Anki Capture record a tab after you invoke it on that tab. " +
  "Go to the tab you want to capture and click the Anki Capture toolbar icon, press Alt+Shift+A, " +
  "or right-click the page → Start Anki Capture. Then start again. " +
  "Chrome's own pages (chrome://, the New Tab page, the Web Store) can never be captured.";

// Never throws: returns { streamId } or { error } so callers can mint early and decide later.
// Chrome only allows this for a tab the extension was invoked on (activeTab; spec.md §6.1.1).
async function mintStreamId(tabId) {
  try {
    return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }) };
  } catch (e) {
    const msg = e?.message || String(e);
    return { error: /not been invoked|cannot be captured/i.test(msg) ? NOT_INVOKED : "Tab capture failed: " + msg };
  }
}

// Time limit: "fixed" stops automatically after `minutes`; "none" runs until stopped manually.
function limitSeconds(mode, minutes) {
  if (mode !== "fixed") return null;
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 1) throw new Error("Enter a time limit of at least 1 minute.");
  return Math.min(m, LIMIT_MAX_MINUTES) * 60;
}

// Starts recording a tab. Missing options fall back to the side panel's saved uiPrefs, which is how
// context-menu and shortcut starts get the deck, prompt, and time limit.
// tabId/pre come only from the menu/shortcut path: pre is an already-minted { streamId } or { error }.
async function startCapture({ deckName, prompt, tabId, pre, limitMode, limitMinutes } = {}) {
  const { settings, uiPrefs } = await chrome.storage.local.get(["settings", "uiPrefs"]);
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  if (!cfg.elevenKey) throw new Error("Missing ElevenLabs API key. Enter it in Settings and save.");
  const cur = await refreshStale();
  if (cur && ACTIVE_STATUSES.includes(cur.status)) throw new Error("A capture session is already active.");
  deckName = (deckName || uiPrefs?.deckName || DEFAULT_DECK).trim() || DEFAULT_DECK;
  prompt = prompt ?? uiPrefs?.prompt ?? "";
  const limitSec = limitSeconds(limitMode ?? uiPrefs?.limitMode ?? "none", limitMinutes ?? uiPrefs?.limitMinutes);
  if (tabId == null) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = t?.id;
  }
  if (tabId == null) throw new Error("No active tab.");
  const minted = pre || await mintStreamId(tabId);
  if (minted.error) throw new Error(minted.error);

  await closeOffscreen();
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["USER_MEDIA"],
    justification: "Record and transcribe captured tab audio."
  });
  const id = `s_${Date.now()}`;
  const now = iso();
  const mode = cfg.sttMode === "batch" ? "batch" : "realtime";
  await patchSession(() => ({
    id, status: "starting", mode, tabId, media: null, limitSec, endedBy: null,
    transcript: "", partial: "", deckName, prompt, startedAt: now, lastHeartbeat: now
  }));

  // The offscreen document replies only once audio is actually flowing to a transcriber.
  let r;
  try {
    r = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START", streamId: minted.streamId, chunkSeconds: cfg.chunkSeconds,
      elevenKey: cfg.elevenKey, sessionId: id, mode, limitSec
    });
  } catch (e) { r = { ok: false, error: e.message }; }
  if (!r?.ok) {
    const msg = r?.error || "Recorder failed to start.";
    await closeOffscreen();
    await patchSession((s) => ({ ...s, status: "error", error: msg }));
    throw new Error(msg);
  }
  await patchSession((s) => (s?.id === id ? { ...s, status: "recording", recorderStartedAt: iso(), lastHeartbeat: iso() } : undefined));
  injectTabUi(tabId);
}

// Pulsing cursor + media-time reporter in the captured tab. Uses the activeTab grant from the
// invocation that allowed capture. Cross-origin frames are skipped; failure only loses the extras.
async function injectTabUi(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["tab-ui.js"] });
  } catch {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ["tab-ui.js"] }); }
    catch (e) { console.warn("[Anki Capture] Could not inject the tab UI:", e.message); }
  }
}

// Media reports from the captured tab's frames. A frame without media only clears media it reported
// itself, and a paused report doesn't replace a fresh playing one from another frame.
// keep: false tells tab-ui.js to remove itself (capture over, or not the captured tab).
function onTabMedia({ media }, sender) {
  const tabId = sender.tab?.id, frameId = sender.frameId ?? 0;
  let keep = false;
  return patchSession((s) => {
    if (!isCapturing(s) || s.tabId !== tabId) return undefined;
    keep = true;
    const cur = s.media;
    const other = cur && cur.frameId !== frameId;
    if (!media) return cur && !other ? { ...s, media: null } : undefined;
    if (other && !cur.paused && media.paused && Date.now() - cur.at < 3000) return undefined;
    return { ...s, media: { ...media, frameId, at: Date.now() } };
  }).then(() => ({ ok: true, keep }));
}

// User-initiated stop. The offscreen document finishes transcribing and then sends OFFSCREEN_COMPLETE.
async function stopCapture() {
  const s = await getSession();
  if (!isCapturing(s)) return;
  await patchSession((x) => ({ ...x, status: "transcribing", endedBy: "user" }));
  try { await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }); }
  catch { await failSession("Capture stopped because the audio recorder is no longer active."); }
}

// Recording and transcription are finished: save the transcript, then optionally generate cards.
// Ignored unless the session is still active, so a repeated COMPLETE can't save or generate twice.
async function onComplete({ sessionId }) {
  const s = await getSession();
  if (!isActive(s, sessionId)) return;
  await closeOffscreen();
  if (!fullText(s)) {
    await patchSession((x) => ({ ...x, status: "error", error: "Empty transcript: no speech was transcribed." }));
    return;
  }
  await saveTranscript(s);
  await patchSession((x) => ({ ...x, status: "done" }));
  const { settings } = await chrome.storage.local.get("settings");
  if (settings?.autoGenerate) {
    try { await generateFor({ transcriptId: s.id, deckName: s.deckName, prompt: s.prompt }); }
    catch (e) { await patchSession((x) => ({ ...x, error: e.message })); }
  }
}

// ---- Gemini generation
// Progress lives in storage key `generation` so the side panel can follow it. Streaming updates
// are throttled to one write per 250 ms; status changes are written immediately.

let gen = null, genTimer = null, genRunning = false;
function pushGen(now) {
  if (now) {
    clearTimeout(genTimer);
    genTimer = null;
    return chrome.storage.local.set({ generation: gen });
  }
  if (!genTimer) genTimer = setTimeout(() => { genTimer = null; chrome.storage.local.set({ generation: gen }); }, 250);
}

// A `running` record with no generation in this worker means the worker restarted mid-run.
async function refreshGen() {
  if (genRunning) return;
  const { generation } = await chrome.storage.local.get("generation");
  if (generation?.status === "running")
    await chrome.storage.local.set({ generation: { ...generation, status: "error", error: "Generation was interrupted.", finishedAt: iso() } });
}

// Generates cards from a saved transcript and appends them to a deck.
async function generateFor({ transcriptId, deckName, prompt }) {
  if (genRunning) throw new Error("Cards are already being generated.");
  const d = await chrome.storage.local.get(["settings", "transcripts"]);
  const cfg = { ...DEFAULT_SETTINGS, ...d.settings };
  if (!cfg.geminiKey) throw new Error("Missing Gemini API key. Enter it in Settings and save.");
  const t = d.transcripts?.[transcriptId];
  if (!t || !t.text.trim()) throw new Error("No saved transcript is available.");
  const name = (deckName || DEFAULT_DECK).trim() || DEFAULT_DECK;
  genRunning = true;
  gen = {
    status: "running", deckName: name, model: cfg.geminiModel,
    chunk: 0, chunks: 0, attempt: 1, received: 0, drafted: [], added: 0, metrics: [], startedAt: iso()
  };
  const t0 = performance.now();
  try {
    await pushGen(true);
    const cards = await generateCards({
      apiKey: cfg.geminiKey, model: cfg.geminiModel, prompt, transcript: t.text,
      onProgress: (p) => {
        Object.assign(gen, { chunk: p.chunk, chunks: p.chunks, attempt: p.attempt, received: p.received, drafted: [...p.fronts, ...p.draft] });
        pushGen();
      },
      onMetrics: (m) => {
        gen.metrics.push(m);
        console.log(`[Anki Capture] Gemini part ${m.chunk}/${m.chunks}`, m);
        pushGen();
      }
    });
    const { decks = {} } = await chrome.storage.local.get("decks");
    decks[name] = [...(decks[name] || []), ...cards.map((c) => ({
      id: crypto.randomUUID(), front: c.front, back: c.back, created: iso(), sourceSessionId: transcriptId
    }))];
    await chrome.storage.local.set({ decks });
    Object.assign(gen, { status: "done", added: cards.length, drafted: cards.map((c) => c.front), wallMs: Math.round(performance.now() - t0), finishedAt: iso() });
    console.log(`[Anki Capture] Generation finished in ${gen.wallMs} ms, ${cards.length} cards`);
    console.table(gen.metrics);
    await pushGen(true);
    return { ok: true, count: cards.length };
  } catch (e) {
    Object.assign(gen, { status: "error", error: e.message || String(e), finishedAt: iso() });
    await pushGen(true);
    throw e;
  } finally {
    genRunning = false;
  }
}

// ---- Messaging

const HANDLERS = {
  // Side panel commands. START takes only the panel's fields: tabId and pre are internal.
  START: ({ deckName, prompt, limitMode, limitMinutes }) => startCapture({ deckName, prompt, limitMode, limitMinutes }),
  STOP: stopCapture,
  GET_STATE: async () => { await refreshGen(); return { ok: true, session: await refreshStale() }; },
  GENERATE: generateFor,
  DELETE_TRANSCRIPT: deleteTranscript,

  // Offscreen recorder events
  OFFSCREEN_CHUNK: ({ sessionId, text }) =>
    patchSession((s) => (isActive(s, sessionId) ? { ...s, transcript: s.transcript + (s.transcript ? " " : "") + text, partial: "" } : undefined)),
  OFFSCREEN_PARTIAL: ({ sessionId, text }) =>
    patchSession((s) => (isActive(s, sessionId) && s.partial !== text ? { ...s, partial: text } : undefined)),
  OFFSCREEN_STOPPING: ({ sessionId, reason }) =>
    patchSession((s) => (s?.id === sessionId && isCapturing(s) ? { ...s, status: "transcribing", endedBy: reason } : undefined)),
  OFFSCREEN_HEARTBEAT: ({ sessionId }) =>
    patchSession((s) => (isActive(s, sessionId) ? { ...s, lastHeartbeat: iso() } : undefined)),
  OFFSCREEN_ERROR: async ({ sessionId, error }) => {
    const s = await getSession();
    if (s?.id === sessionId) await failSession(error);
  },
  OFFSCREEN_COMPLETE: onComplete,

  // Content script in the captured tab
  TAB_MEDIA: onTabMedia
};

// Who may send each message. Content scripts run inside web pages, so a compromised page could
// use tab-ui.js to send anything; it may only send TAB_MEDIA. Everything else must come from the
// extension's own side panel or offscreen document.
const SENDERS = {
  START: "sidepanel", STOP: "sidepanel", GET_STATE: "sidepanel", GENERATE: "sidepanel", DELETE_TRANSCRIPT: "sidepanel",
  OFFSCREEN_CHUNK: "offscreen", OFFSCREEN_PARTIAL: "offscreen", OFFSCREEN_STOPPING: "offscreen",
  OFFSCREEN_HEARTBEAT: "offscreen", OFFSCREEN_ERROR: "offscreen", OFFSCREEN_COMPLETE: "offscreen",
  TAB_MEDIA: "tab"
};
const PAGE_URL = { sidepanel: chrome.runtime.getURL("sidepanel.html"), offscreen: chrome.runtime.getURL("offscreen.html") };

function senderAllowed(type, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const want = SENDERS[type];
  if (want === "tab") return !!sender.tab; // a content script in a tab
  if (sender.tab || typeof sender.url !== "string") return false;
  return sender.url.split(/[?#]/)[0] === PAGE_URL[want];
}

// Unknown types (OFFSCREEN_START/STOP, which the offscreen document answers) return false so the
// other listener's reply is the only one. Handler results without an `ok` field become { ok: true }.
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || !Object.hasOwn(HANDLERS, msg.type)) return false;
  if (!senderAllowed(msg.type, sender)) {
    console.warn(`[Anki Capture] Rejected ${msg.type} from ${sender.url || "unknown sender"}`);
    send({ ok: false, error: "Unauthorized sender." });
    return false;
  }
  HANDLERS[msg.type](msg, sender).then(
    (r) => send(r && typeof r === "object" && "ok" in r ? r : { ok: true }),
    (e) => send({ ok: false, error: e.message || String(e) })
  );
  return true;
});

// ---- Context menu, keyboard shortcut, toolbar icon

// Toggle capture from an extension invocation (context menu or shortcut). These grant activeTab,
// so the stream id is minted first, before any await, while the invocation is fresh.
async function toggleFromInvocation(tab) {
  const pre = tab?.id != null ? mintStreamId(tab.id) : null;
  const s = await refreshStale();
  try {
    if (isCapturing(s)) await stopCapture();
    else if (!s || !ACTIVE_STATUSES.includes(s.status)) await startCapture({ tabId: tab?.id, pre: await pre });
  } catch (e) {
    // No side panel request to reply to, so surface the error as an error session.
    await patchSession(() => ({
      id: `err_${Date.now()}`, status: "error", transcript: "", deckName: "", prompt: "", startedAt: iso(), error: e.message
    }));
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) toggleFromInvocation(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-capture") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  toggleFromInvocation(tab);
});

// Open the panel from onClicked instead of openPanelOnActionClick: only a real action click
// counts as invoking the extension, which grants activeTab so the panel's Start can capture this tab.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ---- Lifecycle

async function init() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  syncUi(await refreshStale());
  await refreshGen();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID, title: "Start Anki Capture",
      contexts: ["page", "selection", "link", "image", "video", "audio"]
    }, () => void chrome.runtime.lastError);
  });
  init();
});
chrome.runtime.onStartup.addListener(init);
