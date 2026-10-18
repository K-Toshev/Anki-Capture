// Side panel UI. Reads state straight from chrome.storage.local and re-renders on every change;
// all capture, transcript, and generation actions go through the service worker as messages.
// Decks are the exception: the panel edits and saves them directly.

import {
  DEFAULT_SETTINGS, DEFAULT_DECK, DEFAULT_PROMPT, LIMIT_DEFAULT_MINUTES, LIMIT_MAX_MINUTES, ACTIVE_STATUSES
} from "./lib/config.js";
import { exportCsv, exportAllCsv } from "./lib/anki.js";
import { exportTranscriptTxt } from "./lib/transcript.js";

// ---- Helpers

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m);

// Builds elements with properties set directly (textContent, never innerHTML).
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
}
const btn = (text, cls, fn) => el("button", { textContent: text, className: `btn ${cls}`, onclick: fn });

let toastTimer;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
}

// 75 -> "1:15", 3725 -> "1:02:05"
function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const kchars = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const secs = (ms) => (ms == null ? "?" : (ms / 1000).toFixed(1) + "s");

// ---- State (mirrors chrome.storage.local)

let settings = { ...DEFAULT_SETTINGS };
let session = null;
let transcripts = {};
let generation = null;
let decks = {};
let lastDecksJson = "{}";      // decks as last saved or seen, to skip re-rendering our own edits
let limitMode = "none";        // "none" | "fixed"
const openDecks = new Set();   // deck names expanded in the list

const sessionActive = () => !!session && ACTIVE_STATUSES.includes(session.status);

// ---- Capture section

const limitMinutesValue = () =>
  Math.min(LIMIT_MAX_MINUTES, Math.max(1, Math.round(Number($("limitMinutes").value)) || LIMIT_DEFAULT_MINUTES));

// Deck, prompt, and time limit are remembered so context-menu and shortcut starts can use them.
const savePrefs = () => chrome.storage.local.set({
  uiPrefs: { deckName: $("deckName").value, prompt: $("prompt").value, limitMode, limitMinutes: limitMinutesValue() }
});

// The limit applies to the next capture, so the picker is locked while one is running.
function renderLimitControls() {
  const busy = sessionActive();
  for (const b of document.querySelectorAll("#limitSeg .seg-btn")) {
    b.classList.toggle("active", b.dataset.mode === limitMode);
    b.disabled = busy;
  }
  $("limitInputRow").hidden = limitMode !== "fixed";
  $("limitMinutes").disabled = busy;
  $("limitHint").textContent = limitMode === "fixed"
    ? `Recording stops automatically after ${limitMinutesValue()} min. The last words are still transcribed.`
    : "Recording runs until you press Stop.";
}

function statusHint(st) {
  const realtime = session?.mode !== "batch";
  if (st === "recording") {
    return realtime
      ? "Live: the count grows as ElevenLabs recognizes speech. Green = words not yet finalized."
      : `The count updates after each ${settings.chunkSeconds}s chunk is recorded, uploaded and transcribed.`;
  }
  if (st === "transcribing") {
    return (session.endedBy === "limit" ? "Time limit reached. " : "") +
      (realtime ? "Finalizing the last words..." : "Finishing the last chunk...");
  }
  if (st === "done" && session.endedBy === "limit") return `Stopped automatically at the ${clock(session.limitSec)} time limit.`;
  if (st === "done" && session.endedBy === "tab") return "Stopped because the captured tab's audio ended (tab closed or navigated away).";
  return "Captures the current tab. Chrome requires clicking the toolbar icon on that tab first (or use Alt+Shift+A / right-click → Start Anki Capture).";
}

function renderStatus() {
  const st = session?.status || "idle";
  $("status").textContent = st;
  $("status").className = `st-${st}`;
  // Character count = committed text + realtime partial (shown separately as "+N LIVE").
  const committed = session?.transcript.length || 0;
  const partial = session?.partial ? session.partial.length + (committed ? 1 : 0) : 0;
  $("count").textContent = committed + partial;
  $("live").textContent = partial ? `+${partial} LIVE` : "";
  $("err").textContent = session?.error || "";
  $("hint").textContent = statusHint(st);
  const capturing = st === "recording" || st === "starting";
  $("toggle").textContent = capturing ? "■ Stop capture" : "● Start capture";
  $("toggle").className = `btn ${capturing ? "stop" : "primary"}`;
  $("toggle").disabled = st === "starting" || st === "transcribing";
  renderLimitControls();
  renderTimer();
}

// Countdown to the automatic stop; turns red in the last minute. Display only: the offscreen
// document enforces the limit.
function renderLimitTimer(elapsed) {
  const limit = session.limitSec;
  const row = $("limitRow");
  $("tLimitBarWrap").hidden = !limit;
  if (!limit) {
    row.classList.remove("ending");
    $("tLimitLabel").textContent = "NO TIME LIMIT";
    $("tLimit").textContent = "stop manually";
    return;
  }
  const left = Math.max(0, limit - elapsed);
  row.classList.toggle("ending", left <= 60);
  $("tLimitLabel").textContent = `AUTO-STOP IN (LIMIT ${clock(limit)})`;
  $("tLimit").textContent = clock(Math.ceil(left));
  $("tLimitBar").style.width = `${Math.min(100, (elapsed / limit) * 100)}%`;
}

// Elapsed capture time, plus time left in the tab's playing media (from tab-ui.js reports),
// extrapolated between the once-a-second reports so it ticks smoothly. Runs every 500 ms.
function renderTimer() {
  const rec = session?.status === "recording";
  $("timer").hidden = !rec;
  if (!rec) return;
  const started = Date.parse(session.recorderStartedAt || session.startedAt);
  const elapsed = (Date.now() - started) / 1000;
  $("tElapsed").textContent = clock(elapsed);
  renderLimitTimer(elapsed);

  const m = session.media;
  const fresh = m && Date.now() - m.at < 5000;
  const left = $("tLeft");
  $("tLeftLabel").textContent = "TIME LEFT";
  $("tBarWrap").hidden = true;
  left.classList.add("idle");
  if (!fresh) {
    left.textContent = "—";
    $("tNote").textContent = Date.now() - started > 4000 ? "No playing video or audio found in this tab." : "";
    return;
  }
  if (m.duration == null) {
    left.textContent = "LIVE";
    $("tNote").textContent = "Live stream: no end time.";
    return;
  }
  const rate = m.playbackRate || 1;
  const cur = Math.min(m.duration, m.currentTime + (m.paused ? 0 : ((Date.now() - m.at) / 1000) * rate));
  left.textContent = clock((m.duration - cur) / rate);
  left.classList.toggle("idle", m.paused);
  if (rate !== 1) $("tLeftLabel").textContent = `TIME LEFT @ ${rate}×`;
  $("tBarWrap").hidden = false;
  $("tBar").style.width = `${(cur / m.duration) * 100}%`;
  $("tNote").textContent = m.paused ? `Media paused at ${clock(cur)} / ${clock(m.duration)}.` : `${clock(cur)} / ${clock(m.duration)}`;
}

$("deckName").oninput = $("prompt").oninput = $("limitMinutes").oninput = savePrefs;
$("limitMinutes").onchange = () => { $("limitMinutes").value = limitMinutesValue(); savePrefs(); renderLimitControls(); };
for (const b of document.querySelectorAll("#limitSeg .seg-btn")) {
  b.onclick = () => { limitMode = b.dataset.mode; savePrefs(); renderLimitControls(); };
}

$("toggle").onclick = async () => {
  $("err").textContent = "";
  const capturing = ["starting", "recording"].includes(session?.status);
  let r;
  if (capturing) r = await send({ type: "STOP" });
  else {
    await savePrefs();
    r = await send({
      type: "START", deckName: $("deckName").value, prompt: $("prompt").value,
      limitMode, limitMinutes: limitMinutesValue()
    });
  }
  if (r && !r.ok) $("err").textContent = r.error;
};

// ---- Transcripts

let knownTranscriptIds = null; // ids seen by the last render; null before the first render

function renderTranscripts() {
  const sel = $("transcriptSel"), prev = sel.value;
  sel.replaceChildren();
  const ids = Object.keys(transcripts).sort((a, b) => transcripts[b].createdAt.localeCompare(transcripts[a].createdAt));
  if (!ids.length) sel.append(el("option", { value: "", textContent: "No saved transcripts" }));
  for (const id of ids) {
    const t = transcripts[id];
    sel.append(el("option", { value: id, textContent: `${new Date(t.createdAt).toLocaleString()} (${t.text.length} chars)` }));
  }
  // A newly saved transcript becomes the selection; otherwise keep the user's choice if it still exists.
  const added = knownTranscriptIds ? ids.find((id) => !knownTranscriptIds.has(id)) : null;
  if (added) sel.value = added;
  else if (ids.includes(prev)) sel.value = prev;
  knownTranscriptIds = new Set(ids);
  $("delTx").disabled = $("exportTx").disabled = !ids.length;
  renderTranscriptText();
}

const selectedTranscript = () => transcripts[$("transcriptSel").value];

function renderTranscriptText() {
  if ($("txPanel").hidden) return;
  const t = selectedTranscript();
  const box = $("txText");
  box.textContent = t?.text || "No transcript selected.";
  box.classList.toggle("empty", !t?.text);
  $("txMeta").textContent = t ? `(${t.text.split(/\s+/).filter(Boolean).length} words)` : "";
  $("copyTx").disabled = !t?.text;
}

$("transcriptSel").onchange = renderTranscriptText;

$("viewTx").onclick = () => {
  const panel = $("txPanel");
  panel.hidden = !panel.hidden;
  $("viewTx").textContent = panel.hidden ? "▤ View text" : "▤ Hide text";
  renderTranscriptText();
};

$("copyTx").onclick = async () => {
  const t = selectedTranscript();
  if (!t?.text) return;
  try { await navigator.clipboard.writeText(t.text); showToast("Transcript copied"); }
  catch (e) { $("genMsg").textContent = "Copy failed: " + e.message; }
};

$("exportTx").onclick = async () => {
  $("genMsg").textContent = "";
  try {
    await exportTranscriptTxt(selectedTranscript());
    showToast("Transcript exported");
  } catch (e) { $("genMsg").textContent = e.message; }
};

$("delTx").onclick = async () => {
  const id = $("transcriptSel").value, t = transcripts[id];
  if (!t) return;
  if (!confirm(`Delete the transcript from ${new Date(t.createdAt).toLocaleString()} (${t.text.length} chars)? Cards already made from it are kept.`)) return;
  const r = await send({ type: "DELETE_TRANSCRIPT", id });
  if (r?.ok) showToast("Transcript deleted");
  else $("genMsg").textContent = r?.error || "Could not delete the transcript.";
};

// ---- Card generation progress

function renderGen() {
  const g = generation, box = $("genProg");
  box.hidden = !g;
  $("gen").disabled = g?.status === "running";
  if (!g) return;
  box.className = g.status;
  const running = g.status === "running";
  $("genPhase").textContent = running
    ? (g.received ? "✦ GEMINI IS WRITING CARDS" : "✦ WAITING FOR GEMINI")
    : g.status === "done" ? `✓ ADDED ${g.added} CARDS → ${g.deckName}` : "✕ GENERATION FAILED";
  // Bar: finished parts, with the current part counted as half done.
  const done = running ? Math.max(0, g.chunk - 1) : g.chunks;
  $("genBar").style.width = running && g.chunks ? `${((done + 0.5) / g.chunks) * 100}%` : "100%";
  const stats = [];
  if (g.chunks > 1) stats.push(running ? `PART ${g.chunk}/${g.chunks}` : `${g.chunks} PARTS`);
  stats.push(`${g.drafted.length} CARD${g.drafted.length === 1 ? "" : "S"} ${running ? "DRAFTED" : ""}`.trim());
  if (running) stats.push(`${kchars(g.received)} CHARS RECEIVED`);
  if (running && g.attempt > 1) stats.push(`RETRY ${g.attempt}`);
  if (g.model) stats.push(g.model);
  $("genStats").textContent = stats.join(" · ");
  renderGenMetrics(g);
  $("genErr").textContent = g.status === "error" ? g.error || "" : "";
  // Live feed of card fronts; keep it scrolled to the bottom unless the user scrolled up.
  const feed = $("genFeed");
  const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 8;
  feed.replaceChildren(...g.drafted.map((f, i) =>
    el("li", { textContent: f, className: running && i === g.drafted.length - 1 ? "drafting" : "" })));
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// Summed token usage and timing for finished parts; per-part detail goes in the tooltip.
function renderGenMetrics(g) {
  const box = $("genMetrics"), ms = g.metrics || [];
  box.replaceChildren();
  box.title = "";
  if (!ms.length) return;
  const sum = (k) => ms.reduce((n, m) => n + (m[k] || 0), 0);
  const firstText = ms.map((m) => m.firstTextMs).filter((v) => v != null);
  const avgFirst = firstText.length ? firstText.reduce((a, b) => a + b, 0) / firstText.length : null;
  const time = g.wallMs ?? sum("totalMs");
  const tok = (label, n, cls = "") => el("span", { className: cls }, `${label} `, el("b", { textContent: kchars(n) }));
  box.append(
    tok("IN", sum("promptTokens")), " · ",
    tok("THINK", sum("thoughtTokens"), "think"), " · ",
    tok("OUT", sum("outputTokens")), " TOK · ",
    "1ST TEXT ", el("b", { textContent: secs(avgFirst) }), " · ",
    "TOTAL ", el("b", { textContent: secs(time) })
  );
  box.title = ms.map((m) =>
    `Part ${m.chunk}/${m.chunks}${m.attempt > 1 ? ` (attempt ${m.attempt})` : ""}, thinking ${m.thinking || "?"}: ` +
    `${m.inputChars} chars in, ${m.promptTokens} prompt tok${m.cachedTokens ? ` (${m.cachedTokens} cached)` : ""}, ` +
    `${m.thoughtTokens} thinking tok, ${m.outputTokens} output tok, ${m.cardsReturned} cards` +
    `${m.cardsRejected ? ` (${m.cardsRejected} rejected)` : ""}; ` +
    `headers ${secs(m.headersMs)}, first text ${secs(m.firstTextMs)}, total ${secs(m.totalMs)}`
  ).join("\n");
}

$("gen").onclick = async () => {
  const id = $("transcriptSel").value;
  if (!id) { $("genMsg").textContent = "No saved transcript is available."; return; }
  await savePrefs();
  $("genMsg").textContent = "";
  $("gen").disabled = true;
  const r = await send({ type: "GENERATE", transcriptId: id, deckName: $("deckName").value, prompt: $("prompt").value });
  $("gen").disabled = generation?.status === "running";
  // Errors raised before the run started (missing key, already running) are not in the progress block.
  if (!r?.ok && !(generation?.status === "error" && generation.error === r?.error))
    $("genMsg").textContent = r?.error || "Generation failed.";
  if (r?.ok) showToast(`Added ${r.count} cards`);
};

$("genClear").onclick = () => {
  if (generation?.status !== "running") chrome.storage.local.remove("generation");
};

// ---- Decks

const saveDecks = () => { lastDecksJson = JSON.stringify(decks); return chrome.storage.local.set({ decks }); };

function renderDecks() {
  const root = $("decks");
  root.replaceChildren();
  const names = Object.keys(decks);
  const total = names.reduce((n, k) => n + decks[k].length, 0);
  $("count-badge").textContent = total;
  $("exportAll").disabled = !total;
  if (!names.length) {
    root.append(el("div", { className: "empty-state" },
      el("div", { className: "icon", textContent: "📭" }),
      el("div", { textContent: "No decks yet." }),
      el("div", { textContent: "Capture a tab to begin." })));
    return;
  }
  for (const name of names) {
    const cards = decks[name];
    const box = el("details", { className: "deck", open: openDecks.has(name) });
    box.ontoggle = () => (box.open ? openDecks.add(name) : openDecks.delete(name));
    box.append(el("summary", {},
      el("span", { className: "name", textContent: name }),
      el("span", { className: "deck-count", textContent: cards.length })));
    const run = (fn) => async () => {
      $("deckMsg").textContent = "";
      try { showToast(await fn()); } catch (e) { $("deckMsg").textContent = e.message; }
    };
    const body = el("div", { className: "deck-body" });
    body.append(el("div", { className: "deck-actions" },
      btn("Add card ✚", "primary", () => {
        cards.push({ id: crypto.randomUUID(), front: "Front", back: "Back", created: new Date().toISOString() });
        saveDecks(); renderDecks();
      }),
      btn("↓ CSV", "export", run(async () => { await exportCsv(name, cards); return "Exported CSV"; })),
      btn("Delete deck", "danger", () => {
        if (!confirm(`Delete deck "${name}"?`)) return;
        delete decks[name]; saveDecks(); renderDecks(); showToast("Deck deleted");
      })));
    // Edits save on `change` (when a field loses focus), without re-rendering, so focus isn't lost.
    for (const card of cards) {
      const f = el("textarea", { value: card.front, rows: 2, onchange: () => { card.front = f.value; saveDecks(); } });
      const b = el("textarea", { value: card.back, rows: 2, onchange: () => { card.back = b.value; saveDecks(); } });
      const del = el("button", { className: "card-del", textContent: "✕", title: "Delete card", onclick: () => {
        decks[name] = cards.filter((c) => c !== card); saveDecks(); renderDecks();
      } });
      body.append(el("div", { className: "card" }, del,
        el("div", { className: "card-label", textContent: "FRONT" }), f,
        el("hr", { className: "card-sep" }),
        el("div", { className: "card-label", textContent: "BACK" }), b));
    }
    box.append(body);
    root.append(box);
  }
}

$("exportAll").onclick = async () => {
  $("deckMsg").textContent = "";
  try {
    const n = await exportAllCsv(decks);
    showToast(`Exported ${n} cards from ${Object.keys(decks).length} decks`);
  } catch (e) { $("deckMsg").textContent = e.message; }
};

// ---- Settings

$("save").onclick = async () => {
  settings = {
    elevenKey: $("elevenKey").value.trim(),
    geminiKey: $("geminiKey").value.trim(),
    geminiModel: $("geminiModel").value.trim() || DEFAULT_SETTINGS.geminiModel,
    chunkSeconds: Math.min(300, Math.max(10, Number($("chunkSeconds").value) || DEFAULT_SETTINGS.chunkSeconds)),
    autoGenerate: $("autoGenerate").checked,
    sttMode: $("sttMode").value === "batch" ? "batch" : "realtime"
  };
  await chrome.storage.local.set({ settings });
  showToast("Settings saved");
};

// ---- Startup and live updates

async function load() {
  const d = await chrome.storage.local.get(["settings", "uiPrefs", "session", "transcripts", "decks", "generation"]);
  settings = { ...DEFAULT_SETTINGS, ...d.settings };
  session = d.session || null;
  transcripts = d.transcripts || {};
  generation = d.generation || null;
  decks = d.decks || {};
  lastDecksJson = JSON.stringify(decks);

  $("elevenKey").value = settings.elevenKey;
  $("geminiKey").value = settings.geminiKey;
  $("geminiModel").value = settings.geminiModel;
  $("chunkSeconds").value = settings.chunkSeconds;
  $("autoGenerate").checked = settings.autoGenerate;
  $("sttMode").value = settings.sttMode;

  const p = d.uiPrefs || {};
  $("deckName").value = p.deckName || DEFAULT_DECK;
  $("prompt").value = p.prompt || DEFAULT_PROMPT;
  limitMode = p.limitMode === "fixed" ? "fixed" : "none";
  $("limitMinutes").value = p.limitMinutes || LIMIT_DEFAULT_MINUTES;

  renderStatus(); renderTranscripts(); renderDecks(); renderGen();
}

chrome.storage.onChanged.addListener((ch) => {
  if (ch.session) { session = ch.session.newValue || null; renderStatus(); }
  if (ch.transcripts) { transcripts = ch.transcripts.newValue || {}; renderTranscripts(); }
  if (ch.generation) { generation = ch.generation.newValue || null; renderGen(); }
  if (ch.decks) {
    const nv = ch.decks.newValue || {};
    if (JSON.stringify(nv) !== lastDecksJson) { decks = nv; lastDecksJson = JSON.stringify(nv); renderDecks(); }
  }
});

setInterval(renderTimer, 500);
// While something is running, poll so the service worker runs stale-session and
// interrupted-generation recovery even if no other event arrives.
setInterval(() => {
  if (sessionActive() || generation?.status === "running") send({ type: "GET_STATE" });
}, 2000);

load();
