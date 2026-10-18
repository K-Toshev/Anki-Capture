// Transcript .txt export, used by the side panel.

import { downloadText } from "./download.js";

const pad = (n) => String(n).padStart(2, "0");

// "transcript-2026-10-18_14-05.txt", from the capture's local time.
function transcriptFilename(t) {
  const d = new Date(t.createdAt);
  return `transcript-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.txt`;
}

// Short header, a blank line, then the transcript text as captured.
function toTranscriptTxt(t) {
  const head = [`Anki Capture transcript`, `Captured: ${new Date(t.createdAt).toLocaleString()}`];
  if (t.prompt) head.push(`Prompt: ${t.prompt.replace(/\s*\n\s*/g, " ")}`);
  return head.join("\n") + "\n\n" + t.text + "\n";
}

export async function exportTranscriptTxt(t) {
  if (!t?.text) throw new Error("No transcript selected.");
  // BOM so older Windows editors detect UTF-8.
  await downloadText("﻿" + toTranscriptTxt(t), transcriptFilename(t));
}
