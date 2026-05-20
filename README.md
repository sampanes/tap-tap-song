# Tap Tap Song

A small static web app for tapping through songs one phrase at a time. It uses plain HTML, CSS, and JavaScript, so it can run from `index.html` directly or from GitHub Pages.

## Run It

Open `index.html` in a browser, or publish the repository with GitHub Pages.

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
