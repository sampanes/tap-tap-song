# Tap Tap Song

A small static web app for tapping through songs one phrase at a time. It uses plain HTML, CSS, and JavaScript, so it can run from `index.html` directly or from GitHub Pages.

## Run It

Live page: https://sampanes.github.io/tap-tap-song/

You can also open `index.html` in a browser locally.

## Player Modes

The player has three tap behaviors:

- **Safe** keeps the original MVP behavior. Taps during playback are ignored.
- **Interrupt** is the default. Each tap stops the current clip and starts the next one.
- **Queue** stores one pending tap during playback and starts the next clip when the current clip ends.

The timing readout shows the previous tap interval and an estimated BPM. New clips use the previous tap interval to set `playbackRate`, so shorter tap gaps compress the next clip and longer gaps stretch it. The rate is clamped to keep playback usable.

## Cutter Workflow

Use the **Cutter** tab to load a full song MP3 from your computer. The file stays local in the browser.

1. Click the waveform to seek.
2. Add manual anchors at important waypoints in the song.
3. Set an approximate gap length, then use **Fill All Anchors** to generate keyframes from the song start to the song end, using manual anchors as waypoints.
4. Use **Clear Last** to undo the last manual anchor, or **Clear Generated** to keep anchors and rerun the fill.
5. Preview each generated snippet from the side panel.
6. Copy the generated CSV or FFmpeg commands from the export box.

The browser tool previews timing and generates commands. FFmpeg does the actual MP3 slicing:

```powershell
ffmpeg -i "full-song.mp3" -ss 0.000 -to 3.500 -c:a libmp3lame -q:a 2 "audio/your-song/001.mp3"
```

Or save the cutter export text as a CSV file and run the helper:

```powershell
.\tools\slice-song.ps1 `
  -Source ".\audio\wellerman\Nathan Evans - Wellerman (Sea Shanty) 1.mp3" `
  -Csv ".\audio\wellerman\slices.csv" `
  -OutputDir ".\audio\wellerman"
```

FFmpeg must be installed and available on `PATH` for the helper to work.

## Audio Files

Place phrase clips in the matching song folder:

```text
audio/wellerman/001.mp3
audio/wellerman/002.mp3
audio/wellerman/003.mp3
```

The sample metadata in `script.js` already points at these paths. Missing files are shown as visible playback errors instead of breaking the page.

## Add A Song

Add another entry to the `SONGS` object in `script.js`:

```js
new-song: {
  title: "New Song",
  loop: true,
  clips: [
    "audio/new-song/001.mp3",
    "audio/new-song/002.mp3"
  ]
}
```

Create the matching folder under `audio/` and add one MP3 per phrase.
