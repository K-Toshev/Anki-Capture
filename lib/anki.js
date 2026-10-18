// Anki CSV export (per deck, or all decks in one file), used by the side panel.

import { downloadText, safeFilename } from "./download.js";

// Fields are HTML (#html:true). Escaping matters: Anki card templates can run JavaScript, so card
// text from a transcript must never reach Anki as live HTML. Tabs become spaces, newlines <br>.
const esc = (s) => String(s).replace(/\t/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>");

// Every field is quoted, so commas are safe; esc() already turned quotes and newlines into HTML,
// but inner quotes are still doubled in case a field ever contains one.
const csvField = (s) => `"${String(s).replace(/"/g, '""')}"`;
const headerValue = (s) => String(s).replace(/[\r\n]+/g, " ").trim();

// Anki (2.1.55+) reads these "#key:value" header lines to set up the import automatically.
// One deck: every note goes into `deckName`.
function toCsv(deckName, cards) {
  const head = [
    "#separator:Comma",
    "#html:true",
    "#notetype:Basic",
    `#deck:${headerValue(deckName)}`,
    "#columns:Front,Back"
  ];
  return [...head, ...cards.map((c) => `${csvField(esc(c.front))},${csvField(esc(c.back))}`)].join("\n") + "\n";
}

// All decks in one file: the third column names each note's deck.
function toCsvAll(decks) {
  const head = ["#separator:Comma", "#html:true", "#notetype:Basic", "#columns:Front,Back,Deck", "#deck column:3"];
  const rows = Object.entries(decks).flatMap(([name, cards]) =>
    cards.map((c) => `${csvField(esc(c.front))},${csvField(esc(c.back))},${csvField(headerValue(name))}`));
  return [...head, ...rows].join("\n") + "\n";
}

const download = (text, filename) => downloadText(text, filename, "text/csv;charset=utf-8");

export async function exportCsv(deckName, cards) {
  if (!cards.length) throw new Error("Deck has no cards.");
  await download(toCsv(deckName, cards), safeFilename(deckName) + ".csv");
}

export async function exportAllCsv(decks) {
  const count = Object.values(decks).reduce((n, cards) => n + cards.length, 0);
  if (!count) throw new Error("There are no cards to export.");
  await download(toCsvAll(decks), "AnkiCapture-all-decks.csv");
  return count;
}
