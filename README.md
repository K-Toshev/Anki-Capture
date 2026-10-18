# Anki Capture

A Chrome extension that turns what you're listening to into Anki flashcards. It records the audio of a browser tab (a lecture, a YouTube video, a talk), transcribes it live with ElevenLabs, generates flashcards from the transcript with Google Gemini, and exports them as a CSV that Anki imports in one step.

Everything happens in a side panel next to the page you're watching.

## Features

- **Tab audio capture.** Records one tab's audio while you keep hearing it. Start and stop from the side panel, the right-click menu, or **Alt+Shift+A**.
- **Live transcription.** ElevenLabs realtime speech-to-text; the character count grows as words are recognized. A batch mode (timed uploads) is also available.
- **Recording timer.** Elapsed time, time left in the video or audio playing in the tab (adjusted for playback speed), and an optional automatic stop after a set number of minutes. The mouse pointer on the captured page pulses red and white while recording.
- **Flashcard generation.** Gemini writes cards from a saved transcript, using your own instructions. A progress view shows cards as they're drafted, with token and timing stats. Can run automatically when a capture ends.
- **Deck editing.** Edit, add, and delete cards; cards are grouped into named decks.
- **Export.** Anki CSV per deck or for all decks at once (each card goes into its deck). Transcripts can be viewed, copied, exported as `.txt`, or deleted.

## Requirements

- Google Chrome 116 or newer
- An [ElevenLabs](https://elevenlabs.io) API key (speech-to-text)
- A [Google Gemini](https://aistudio.google.com/apikey) API key
- Anki 2.1.55 or newer, to import the CSV files

## Installation

There is no build step.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. Optional: pin **Anki Capture** to the toolbar from the puzzle-piece menu.

After changing any file, click the reload icon on the extension's card in `chrome://extensions`.

## Setup

1. Click the Anki Capture toolbar icon to open the side panel.
2. Open **Settings** and enter your ElevenLabs and Gemini API keys.
3. Click **Save settings**.

The default model is `gemini-3.8-flash`. If your key doesn't have access to it, generation fails with a "may not be available to this API key" error; enter another model name (for example `gemini-2.5-flash`) and save.

## Usage

### Capture a tab

1. Go to the tab you want to capture and **click the Anki Capture toolbar icon on that tab**. Chrome only lets an extension record a tab after you invoke it there (see [Troubleshooting](#troubleshooting)).
2. In the side panel, set the **deck** the cards should go into and a **prompt** describing what kind of cards you want.
3. Choose a **time limit**: **No limit** (record until you stop), or **Stop after…** a number of minutes.
4. Click **Start capture**.

You can also start or stop without the panel: press **Alt+Shift+A**, or right-click the page and choose **Start / Stop Anki Capture**. These use the deck, prompt, and time limit last set in the panel.

Recording stops when you press Stop (or use the shortcut or menu again), when the time limit is reached, or when the tab is closed or navigates away. The last words are still transcribed and the transcript is saved.

### Make cards

1. The newest transcript is selected automatically under **Transcript**. Use **View text** to read it.
2. Click **Generate cards**. The progress area shows each card as Gemini writes it.
3. The cards appear under **Decks**, where you can edit, add, or delete them.

To skip this step, turn on **Auto-generate cards after capture** in Settings.

### Import into Anki

1. Click **↓ CSV** on a deck, or **↓ CSV (all)** for every deck.
2. In Anki, choose **File → Import** and pick the file.

The file tells Anki everything it needs (separator, HTML, the Basic note type, and the deck), so the import dialog is already filled in. Nested deck names like `Biology::Cells` become nested decks.

## Settings

| Setting | Default | Notes |
|---|---|---|
| ElevenLabs API key | — | Required to capture. |
| Gemini API key | — | Required to generate cards. |
| Gemini model | `gemini-3.8-flash` | Any Gemini model your key can use. |
| Transcription | Realtime | **Realtime** streams audio for live text (`scribe_v2_realtime`). **Batch** uploads a recording chunk every *Chunk seconds* (`scribe_v1`); text appears after each upload. |
| Chunk seconds | 45 | Batch mode only (10–300). |
| Auto-generate cards after capture | Off | Generates cards as soon as a capture finishes. |

## Privacy and security

- **Your API keys** are stored in Chrome's extension storage on your computer, **unencrypted**. Anything that can read your Chrome profile can read them. Use keys with limited permissions and spending limits: an ElevenLabs key with only Speech-to-Text access and a credit limit, and a Gemini key restricted to the Generative Language API with a budget alert.
- **Captured audio** is sent to ElevenLabs, and **transcripts** are sent to Google's Gemini API. Their data policies apply; on Gemini's free tier, Google may use inputs and outputs to improve its products. Avoid capturing confidential conversations unless that's acceptable to you.
- **Transcripts and cards** are stored locally until you delete them.
- The extension has no server of its own, loads no remote code, and only talks to ElevenLabs and Google.
- Transcript text is treated as untrusted when it's sent to Gemini, and generated cards are checked and escaped before they're shown or exported. See `spec.md` §10.2 and §13 for details.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Chrome only lets Anki Capture record a tab after you invoke it on that tab" | Click the toolbar icon while on the tab you want (or use Alt+Shift+A or the right-click menu there), then start again. Chrome drops this permission when the tab navigates and never shares it with other tabs. |
| Nothing can be captured on a page | Chrome's own pages (`chrome://…`, the New Tab page, the Chrome Web Store) can't be captured. |
| Alt+Shift+A does nothing | Set or change the shortcut at `chrome://extensions/shortcuts`. |
| **Time left** shows `—` | No playing video or audio was found. Players embedded from another site (some lecture platforms) can't be read; elapsed time still works. |
| "Empty transcript: no speech was transcribed." | The tab had no speech, or it was muted at the source. |
| Gemini "may not be available to this API key" | Change **Gemini model** in Settings and save. |
| Something looks stuck | Open `chrome://extensions`, click **service worker** under Anki Capture, and check the console for `[Anki Capture]` messages. |

## How it works

```text
side panel  ──messages──▶  service worker  ──▶  offscreen document  ──▶  ElevenLabs
(sidepanel.*)              (background.js)      (offscreen.js,            (speech-to-text)
     ▲                       │    │              pcm-worklet.js)
     └── chrome.storage ─────┘    └──▶ Gemini (lib/gemini.js)
                                  └──▶ tab-ui.js in the captured tab (cursor, media time)
```

- The **service worker** owns all state (session, transcripts, generation progress) in `chrome.storage.local` and coordinates everything.
- The **offscreen document** holds the tab's audio stream, keeps it audible, and transcribes it, so recording doesn't depend on the service worker staying awake.
- The **side panel** renders straight from storage and sends commands to the service worker.

[`spec.md`](spec.md) is the full specification: storage schema, message types, capture lifecycle, error messages, and security design.

## Project structure

```text
manifest.json      Extension manifest (Manifest V3)
background.js      Service worker: state, capture control, Gemini generation, messaging, menu/shortcut
offscreen.html/.js Records the tab and transcribes it (realtime WebSocket or batch uploads)
pcm-worklet.js     Converts tab audio to 16 kHz mono PCM for realtime transcription
tab-ui.js          Injected into the captured tab: pulsing cursor, media-time reports
sidepanel.html/.js The side panel UI
lib/config.js      Shared defaults and constants
lib/gemini.js      Gemini requests, prompt-injection defenses, card checks
lib/anki.js        Anki CSV export
lib/transcript.js  Transcript .txt export
lib/download.js    Save-As download helper
spec.md            Full specification
```

## Development

- Plain JavaScript, HTML, and CSS: no frameworks, bundler, or dependencies.
- Syntax check: `node --check` on each `.js` file.
- Debugging: the service worker's console (`chrome://extensions` → **service worker**) logs Gemini timing and token use per request and any rejected messages or cards. The side panel and offscreen document have their own consoles (right-click → Inspect, or via `chrome://extensions`).
