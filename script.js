const SONGS = {
  wellerman: {
    title: "Wellerman",
    loop: true,
    clips: [
      "audio/wellerman/001.mp3",
      "audio/wellerman/002.mp3",
      "audio/wellerman/003.mp3"
    ]
  },
  "example-song": {
    title: "Example Song",
    loop: false,
    clips: [
      "audio/example-song/001.mp3",
      "audio/example-song/002.mp3"
    ]
  }
};

const songSelect = document.querySelector("#song-select");
const songTitle = document.querySelector("#song-title");
const phraseProgress = document.querySelector("#phrase-progress");
const tapTarget = document.querySelector("#tap-target");
const resetButton = document.querySelector("#reset-button");
const statusLine = document.querySelector("#status-line");

let currentSongKey = Object.keys(SONGS)[0];
let phraseIndex = 0;
let activeAudio = null;
let nextAudio = null;
let isPlaying = false;
let isComplete = false;

function initialize() {
  Object.entries(SONGS).forEach(([key, song]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = song.title;
    songSelect.append(option);
  });

  songSelect.value = currentSongKey;
  selectSong(currentSongKey);

  songSelect.addEventListener("change", () => selectSong(songSelect.value));
  tapTarget.addEventListener("click", playNextPhrase);
  resetButton.addEventListener("click", resetSong);
}

function selectSong(songKey) {
  currentSongKey = songKey;
  stopActiveAudio();
  phraseIndex = 0;
  isComplete = false;
  preloadNextClip();
  render();
  setStatus("Ready");
}

function resetSong() {
  stopActiveAudio();
  phraseIndex = 0;
  isComplete = false;
  preloadNextClip();
  render();
  setStatus("Back to the first phrase");
}

function playNextPhrase() {
  const song = getCurrentSong();

  if (!song.clips.length) {
    setStatus("This song does not have any audio clips yet.", true);
    return;
  }

  if (isPlaying) {
    // Mobile browsers can overlap sounds if taps arrive quickly. Ignoring taps
    // while audio plays keeps playback predictable and easy for children.
    setStatus("Playing...");
    return;
  }

  if (isComplete) {
    if (!song.loop) {
      setStatus("Song complete. Press Reset to start again.");
      return;
    }

    phraseIndex = 0;
    isComplete = false;
  }

  const clipIndex = phraseIndex;
  const audio = nextAudio && nextAudio.src.endsWith(song.clips[clipIndex])
    ? nextAudio
    : new Audio(song.clips[clipIndex]);

  activeAudio = audio;
  nextAudio = null;
  isPlaying = true;
  tapTarget.disabled = true;
  setStatus("Loading...");

  audio.addEventListener("canplaythrough", () => setStatus("Playing..."), { once: true });
  audio.addEventListener("ended", onPhraseEnded, { once: true });
  audio.addEventListener("error", onAudioError, { once: true });

  const playPromise = audio.play();

  if (playPromise) {
    playPromise.catch(() => {
      isPlaying = false;
      tapTarget.disabled = false;
      setStatus("Could not play this clip. Check the audio file path.", true);
    });
  }
}

function onPhraseEnded() {
  const song = getCurrentSong();

  phraseIndex += 1;
  isPlaying = false;
  tapTarget.disabled = false;

  if (phraseIndex >= song.clips.length) {
    if (song.loop) {
      phraseIndex = 0;
      setStatus("Ready to loop");
    } else {
      phraseIndex = song.clips.length;
      isComplete = true;
      setStatus("Song complete");
    }
  } else {
    setStatus("Ready");
  }

  preloadNextClip();
  render();
}

function onAudioError() {
  isPlaying = false;
  tapTarget.disabled = false;
  setStatus("Missing audio clip. Add the file or update the song metadata.", true);
}

function preloadNextClip() {
  const song = getCurrentSong();
  const clip = song.clips[phraseIndex];

  nextAudio = clip ? new Audio(clip) : null;

  if (nextAudio) {
    nextAudio.preload = "auto";
    nextAudio.load();
  }
}

function stopActiveAudio() {
  if (!activeAudio) {
    return;
  }

  activeAudio.pause();
  activeAudio.currentTime = 0;
  activeAudio = null;
  isPlaying = false;
  tapTarget.disabled = false;
}

function render() {
  const song = getCurrentSong();
  const total = song.clips.length;
  const visiblePhrase = total === 0 ? 0 : Math.min(phraseIndex + 1, total);

  songTitle.textContent = song.title;
  phraseProgress.textContent = `Phrase ${visiblePhrase} / ${total}`;
  tapTarget.setAttribute("aria-label", `Play phrase ${visiblePhrase} of ${total}`);
}

function setStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
}

function getCurrentSong() {
  return SONGS[currentSongKey];
}

initialize();
