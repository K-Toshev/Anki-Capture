// Injected into the captured tab (every accessible frame) while recording.
// - Pulses the mouse pointer between red and white.
// - Reports the playing <video>/<audio> element's position once a second so the side panel can show time left.
// Stops itself as soon as the service worker answers a report with keep: false.
(() => {
  if (window.__ankiCaptureUi) return;
  window.__ankiCaptureUi = true;

  const PERIOD_MS = 1200; // matches the side panel's REC dot pulse
  const STEPS = 12;
  const root = document.documentElement;

  // Red (#ff4a6e) → white → red, as a smooth cycle of STEPS colors.
  const mix = (t) => {
    const k = (1 - Math.cos(2 * Math.PI * t)) / 2; // 0 → 1 → 0
    const c = (a) => Math.round(a + (255 - a) * k);
    return `rgb(${c(255)},${c(74)},${c(110)})`;
  };
  const cursor = (fill) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">` +
      `<circle cx="10" cy="10" r="7" fill="${fill}" stroke="#0e0e1c" stroke-width="2"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, auto`;
  };
  const style = document.createElement("style");
  style.textContent = Array.from({ length: STEPS }, (_, i) =>
    `html[data-anki-rec="${i}"], html[data-anki-rec="${i}"] * { cursor: ${cursor(mix(i / STEPS))} !important; }`
  ).join("\n");
  (document.head || root).append(style);

  let step = 0;
  root.dataset.ankiRec = "0";
  const pulse = setInterval(() => { step = (step + 1) % STEPS; root.dataset.ankiRec = String(step); }, PERIOD_MS / STEPS);

  // Prefer a playing element with a known duration, then the longest one.
  function pickMedia() {
    const els = [...document.querySelectorAll("video, audio")].filter((m) => m.readyState > 0);
    if (!els.length) return null;
    const score = (m) => (!m.paused ? 2 : 0) + (Number.isFinite(m.duration) && m.duration > 0 ? 1 : 0);
    els.sort((a, b) => score(b) - score(a) || (b.duration || 0) - (a.duration || 0));
    const m = els[0];
    return {
      currentTime: m.currentTime,
      duration: Number.isFinite(m.duration) ? m.duration : null, // null = live stream
      playbackRate: m.playbackRate || 1,
      paused: m.paused || m.ended
    };
  }

  function cleanup() {
    clearInterval(pulse);
    clearInterval(report);
    style.remove();
    delete root.dataset.ankiRec;
    window.__ankiCaptureUi = false;
  }

  const send = async () => {
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: "TAB_MEDIA", media: pickMedia() }); } catch {}
    if (!r?.keep) cleanup();
  };
  const report = setInterval(send, 1000);
  send();
})();
