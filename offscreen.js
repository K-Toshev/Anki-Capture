// Offscreen document: records the captured tab and transcribes it with ElevenLabs.
//
// Runs separately from the service worker so recording survives the worker going idle. It never
// touches storage; it reports to the service worker with OFFSCREEN_* messages:
//   CHUNK (finalized text), PARTIAL (realtime text not yet final), HEARTBEAT (every second),
//   STOPPING (it is stopping itself: time limit or tab audio ended), ERROR, COMPLETE.
//
// Two transcription modes:
//   realtime (default) - 16 kHz PCM from pcm-worklet.js streamed over a WebSocket (scribe_v2_realtime)
//   batch              - standalone WebM chunks uploaded every chunkSeconds (scribe_v1)

const MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const RT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const RT_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const RT_RATE = 16000;
const RT_SEND_SAMPLES = 4000;        // ~250 ms per WebSocket message
const RT_MAX_BUFFER = RT_RATE * 30;  // keep at most 30 s of audio while reconnecting
const RT_FATAL = ["auth_error", "quota_exceeded", "unaccepted_terms", "invalid_request", "input_error", "chunk_size_exceeded"];
const RT_IGNORED = ["commit_throttled"];
let state = null; // the one capture in progress, or null
const post = (m) => chrome.runtime.sendMessage(m).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === "OFFSCREEN_START") {
    start(msg).then(() => send({ ok: true }), (e) => send({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "OFFSCREEN_STOP") { send({ ok: true }); stop(); }
  return false;
});

// Resolves only once audio is flowing to a transcriber, so "recording" in the UI is always real.
// limitSec: positive number = stop automatically after that many seconds; null/0 = no limit.
async function start({ streamId, chunkSeconds, elevenKey, sessionId, mode, limitSec }) {
  if (state) throw new Error("Recorder already running.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // keep tab audible
  await ctx.resume();
  const s = state = {
    stream, ctx, source, sessionId, elevenKey, mode: mode === "batch" ? "batch" : "realtime",
    chunkMs: Math.max(10, chunkSeconds || 45) * 1000,
    stopping: false, failed: false, queue: Promise.resolve(), recorder: null, chunkTimer: null, hbTimer: null, rt: null,
    limitTimer: null
  };
  try {
    if (s.mode === "batch") startRecorder(s);
    else await startRealtime(s);
  } catch (e) {
    teardownRealtime(s);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    state = null;
    throw e;
  }
  stream.getAudioTracks()[0].onended = () => autoStop(s, "tab");
  if (limitSec > 0) s.limitTimer = setTimeout(() => autoStop(s, "limit"), limitSec * 1000);
  post({ type: "OFFSCREEN_HEARTBEAT", sessionId });
  s.hbTimer = setInterval(() => post({ type: "OFFSCREEN_HEARTBEAT", sessionId }), 1000);
}

// Stop that the offscreen document starts itself (time limit reached, or the tab's audio ended).
// Tells the service worker first so the session shows "transcribing" while the last words finish.
function autoStop(s, reason) {
  if (state !== s || s.stopping || s.failed) return;
  post({ type: "OFFSCREEN_STOPPING", sessionId: s.sessionId, reason });
  stop();
}

// ---- batch mode: standalone WebM chunks uploaded to /v1/speech-to-text

function startRecorder(s) {
  const rec = new MediaRecorder(s.stream, { mimeType: MIME });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = (e) => fail(e.error?.message || "Recorder error.");
  rec.onstop = () => {
    if (s.failed) return;
    const blob = new Blob(parts, { type: MIME });
    if (blob.size) enqueue(s, blob);
    else if (!s.stopping) return fail("Empty audio chunk was recorded.");
    if (s.stopping) finish(s); else startRecorder(s);
  };
  rec.start(); // no timeslice: each chunk is a standalone WebM file
  s.recorder = rec;
  s.chunkTimer = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, s.chunkMs);
}

// Chunks are transcribed one at a time, in order.
function enqueue(s, blob) {
  s.queue = s.queue.then(async () => {
    if (s.failed) return;
    const text = await transcribe(blob, s.elevenKey);
    if (text && !s.failed) post({ type: "OFFSCREEN_CHUNK", sessionId: s.sessionId, text });
  }).catch((e) => fail(e.message || String(e)));
}

// Up to 3 attempts with 2 s / 4 s backoff; 400, 401, 403, and 422 are permanent.
async function transcribe(blob, key) {
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(1000 * 2 ** i);
    let res;
    try {
      const fd = new FormData();
      fd.append("file", blob, "capture.webm");
      fd.append("model_id", "scribe_v1");
      res = await fetch(STT_URL, { method: "POST", headers: { "xi-api-key": key }, body: fd });
    } catch (e) {
      last = new Error("Could not reach ElevenLabs. " + e.message);
      continue;
    }
    if (!res.ok) {
      const err = new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if ([400, 401, 403, 422].includes(res.status)) throw err;
      last = err;
      continue;
    }
    return ((await res.json()).text || "").trim();
  }
  throw last;
}

// ---- realtime mode: 16 kHz PCM streamed over a WebSocket, live partial transcripts

async function startRealtime(s) {
  await s.ctx.audioWorklet.addModule("pcm-worklet.js");
  const node = new AudioWorkletNode(s.ctx, "pcm-capture");
  s.source.connect(node);
  node.connect(s.ctx.destination); // the worklet outputs silence; connecting keeps it processing
  s.rt = {
    node, ws: null, ready: false, closing: false, bufs: [], len: 0, attempts: 0,
    partial: "", partialTimer: null, onCommit: null
  };
  node.port.onmessage = (e) => onPcm(s, e.data);
  await connectRealtime(s);
}

// The browser WebSocket can't send an API-key header, so each connection uses a single-use token.
async function fetchRealtimeToken(key) {
  let res;
  try { res = await fetch(RT_TOKEN_URL, { method: "POST", headers: { "xi-api-key": key } }); }
  catch (e) { throw new Error("Could not reach ElevenLabs. " + e.message); }
  if (!res.ok) throw new Error(`ElevenLabs token HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { token } = await res.json();
  if (!token) throw new Error("ElevenLabs did not return a realtime token.");
  return token;
}

// Resolves once the server sends session_started; rejects on error, close, or timeout before that.
async function connectRealtime(s) {
  const rt = s.rt;
  const token = await fetchRealtimeToken(s.elevenKey);
  const q = new URLSearchParams({ model_id: "scribe_v2_realtime", token, audio_format: "pcm_16000", commit_strategy: "vad" });
  const ws = new WebSocket(`${RT_URL}?${q}`);
  rt.ws = ws;
  rt.ready = false;
  await new Promise((resolve, reject) => {
    let settled = false, opened = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => { settle(new Error("Timed out connecting to ElevenLabs realtime transcription.")); ws.close(); }, 10000);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.message_type === "session_started") {
        rt.ready = opened = true;
        rt.attempts = 0;
        settle();
        flushPcm(s);
      } else if (m.message_type === "partial_transcript") {
        setPartial(s, m.text || "");
      } else if (m.message_type === "committed_transcript") {
        commitText(s, m.text || "");
      } else if (m.error && !RT_IGNORED.includes(m.message_type)) {
        const err = new Error(`ElevenLabs ${m.message_type}: ${m.error}`);
        if (!settled) return settle(err);
        if (RT_FATAL.includes(m.message_type)) fail(err.message);
        else ws.close(); // recoverable (e.g. session time limit): onclose reconnects
      }
    };
    ws.onclose = (e) => {
      if (rt.ws !== ws) return;
      rt.ready = false;
      if (!opened) return settle(new Error(`ElevenLabs closed the realtime connection (${e.code}${e.reason ? ": " + e.reason : ""}).`));
      if (!rt.closing && !s.stopping && !s.failed) reconnect(s);
    };
  });
}

// Called when a working connection drops. Up to 3 attempts (1 s, 2 s, 4 s), then the capture fails.
async function reconnect(s) {
  const rt = s.rt;
  if (rt.partial) commitText(s, rt.partial); // keep words the closed session never committed
  while (!rt.closing && !s.stopping && !s.failed) {
    if (++rt.attempts > 3) return fail("Lost connection to ElevenLabs realtime transcription.");
    await sleep(1000 * 2 ** (rt.attempts - 1));
    try { await connectRealtime(s); return; } catch {}
  }
}

// 100 ms PCM blocks from the worklet are buffered and sent ~4 per second.
function onPcm(s, block) {
  const rt = s.rt;
  if (!rt || rt.closing) return;
  rt.bufs.push(block);
  rt.len += block.length;
  while (rt.len > RT_MAX_BUFFER) rt.len -= rt.bufs.shift().length;
  if (rt.len >= RT_SEND_SAMPLES) flushPcm(s);
}

function flushPcm(s, commit = false) {
  const rt = s.rt;
  if (!rt.ready || rt.ws?.readyState !== WebSocket.OPEN) return false;
  if (!rt.len && !commit) return false;
  if (!rt.len) { rt.bufs.push(new Int16Array(RT_RATE / 10)); rt.len = RT_RATE / 10; } // commit needs some audio
  const pcm = new Int16Array(rt.len);
  let o = 0;
  for (const b of rt.bufs) { pcm.set(b, o); o += b.length; }
  rt.bufs = [];
  rt.len = 0;
  rt.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: toBase64(pcm.buffer), commit, sample_rate: RT_RATE }));
  return true;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Partials arrive many times per second; forward at most every 250 ms.
function setPartial(s, text) {
  const rt = s.rt;
  rt.partial = text.trim();
  if (rt.partialTimer) return;
  rt.partialTimer = setTimeout(() => {
    rt.partialTimer = null;
    if (!s.failed) post({ type: "OFFSCREEN_PARTIAL", sessionId: s.sessionId, text: rt.partial });
  }, 250);
}

// Finalized text: forward it and clear the partial (or just clear the partial if empty).
function commitText(s, text) {
  const rt = s.rt;
  clearTimeout(rt.partialTimer);
  rt.partialTimer = null;
  rt.partial = "";
  text = text.trim();
  if (text && !s.failed) post({ type: "OFFSCREEN_CHUNK", sessionId: s.sessionId, text });
  else if (!s.failed) post({ type: "OFFSCREEN_PARTIAL", sessionId: s.sessionId, text: "" });
  if (rt.onCommit) rt.onCommit();
}

// Flush remaining audio with commit=true and wait briefly for the final committed transcript.
async function stopRealtime(s) {
  const rt = s.rt;
  if (flushPcm(s, true)) await new Promise((r) => { rt.onCommit = r; setTimeout(r, 4000); });
  if (rt.partial) commitText(s, rt.partial);
  teardownRealtime(s);
}

function teardownRealtime(s) {
  const rt = s.rt;
  if (!rt) return;
  rt.closing = true;
  clearTimeout(rt.partialTimer);
  try { rt.node.port.onmessage = null; rt.node.disconnect(); } catch {}
  try { rt.ws?.close(1000); } catch {}
}

// ---- shared stop/fail

// Normal stop (Stop button, time limit, or tab audio ended): stop recording, let pending
// transcription finish in finish(), then report OFFSCREEN_COMPLETE.
function stop() {
  const s = state;
  if (!s || s.stopping) return;
  s.stopping = true;
  clearTimeout(s.chunkTimer);
  clearTimeout(s.limitTimer);
  if (s.rt || s.recorder.state === "inactive") finish(s); else s.recorder.stop();
}

async function finish(s) {
  s.stream.getTracks().forEach((t) => t.stop());
  if (s.rt) await stopRealtime(s);
  await s.queue;
  clearInterval(s.hbTimer);
  await s.ctx.close().catch(() => {});
  if (!s.failed) post({ type: "OFFSCREEN_COMPLETE", sessionId: s.sessionId });
  if (state === s) state = null;
}

// Unrecoverable error: stop everything immediately and report it; queued work is skipped.
function fail(error) {
  const s = state;
  if (!s || s.failed) return;
  s.failed = true;
  clearTimeout(s.chunkTimer);
  clearTimeout(s.limitTimer);
  clearInterval(s.hbTimer);
  try { if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop(); } catch {}
  teardownRealtime(s);
  s.stream.getTracks().forEach((t) => t.stop());
  post({ type: "OFFSCREEN_ERROR", sessionId: s.sessionId, error });
}
