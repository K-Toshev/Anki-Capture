export const safeFilename = (name) => name.replace(/[\\/:*?"<>|]/g, "_");

// Saves text through chrome.downloads with a Save As dialog.
export async function downloadText(text, filename, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try { await chrome.downloads.download({ url, filename, saveAs: true }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
