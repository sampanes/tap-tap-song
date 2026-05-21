const SONGS = {
  wellerman: {
    title: "Wellerman",
    loop: true,
    clips: Array.from(
      { length: 255 },
      (_, index) => `audio/wellerman/${String(index + 1).padStart(3, "0")}.mp3`
    )
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
const playbackModeButtons = document.querySelectorAll("[data-playback-mode]");
const tapIntervalReadout = document.querySelector("#tap-interval");
const tapBpmReadout = document.querySelector("#tap-bpm");
const playbackRateReadout = document.querySelector("#playback-rate");
const playerModeButton = document.querySelector("#player-mode-button");
const cutterModeButton = document.querySelector("#cutter-mode-button");
const playerView = document.querySelector("#player-view");
const cutterView = document.querySelector("#cutter-view");

const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2.5;

let currentSongKey = Object.keys(SONGS)[0];
let phraseIndex = 0;
let activeClipIndex = null;
let activeAudio = null;
let nextAudio = null;
let isPlaying = false;
let isComplete = false;
let playbackMode = "interrupt";
let hasQueuedTap = false;
let playbackToken = 0;
let lastTapTime = 0;
let tapIntervals = [];

const playerEngine = {
  audioContext: null,
  bufferCache: new Map(),
  activeSource: null
};

function initialize() {
  Object.entries(SONGS).forEach(([key, song]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = song.title;
    songSelect.append(option);
  });

  songSelect.value = currentSongKey;
  selectSong(currentSongKey);
  renderPlaybackMode();

  songSelect.addEventListener("change", () => selectSong(songSelect.value));
  tapTarget.addEventListener("pointerdown", handleTap);
  tapTarget.addEventListener("click", (event) => {
    if (event.detail === 0) {
      handleTap(event);
    }
  });
  resetButton.addEventListener("click", resetSong);
  playbackModeButtons.forEach((button) => {
    button.addEventListener("click", () => setPlaybackMode(button.dataset.playbackMode));
  });
  playerModeButton.addEventListener("click", () => setMode("player"));
  cutterModeButton.addEventListener("click", () => setMode("cutter"));
  initializeCutter();
}

function setMode(mode) {
  const isCutter = mode === "cutter";
  playerView.classList.toggle("hidden", isCutter);
  cutterView.classList.toggle("hidden", !isCutter);
  playerModeButton.classList.toggle("active", !isCutter);
  cutterModeButton.classList.toggle("active", isCutter);
  songSelect.disabled = isCutter;

  if (isCutter) {
    stopActiveAudio();
    if (playerEngine.audioContext && playerEngine.audioContext.state === "running") {
      playerEngine.audioContext.suspend();
    }
    drawCutterWaveforms();
  } else {
    pauseCutterAudio();
  }
}

function selectSong(songKey) {
  currentSongKey = songKey;
  stopActiveAudio();
  phraseIndex = 0;
  activeClipIndex = null;
  isComplete = false;
  hasQueuedTap = false;
  resetTapTiming();
  preloadNextClip();
  render();
  setStatus("Ready");
}

function resetSong() {
  stopActiveAudio();
  phraseIndex = 0;
  activeClipIndex = null;
  isComplete = false;
  hasQueuedTap = false;
  resetTapTiming();
  preloadNextClip();
  render();
  setStatus("Back to the first phrase");
}

function handleTap(event) {
  event.preventDefault();
  pulseTapTarget();
  recordTapTiming();
  playNextPhrase();
}

function playNextPhrase() {
  const song = getCurrentSong();

  if (!song.clips.length) {
    setStatus("This song does not have any audio clips yet.", true);
    return;
  }

  // Safe mode preserves the original MVP behavior: a tap during playback only
  // updates diagnostics and the button pulse. It never changes active audio.
  if (playbackMode === "safe" && isPlaying) {
    setStatus("Playing...");
    return;
  }

  // Queue mode stores at most one pending tap, then spends it immediately when
  // the current clip naturally ends. Extra taps keep the same single queue slot.
  if (playbackMode === "queue" && isPlaying) {
    hasQueuedTap = true;
    setStatus("Queued");
    render();
    return;
  }

  // Interrupt mode makes each tap feel responsive by ending the current phrase
  // right away and starting the next available phrase.
  if (playbackMode === "interrupt" && isPlaying) {
    stopActiveAudio(false);
  }

  startNextPhrase();
}

async function startNextPhrase() {
  const song = getCurrentSong();

  if (isPlaying) {
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
  const clipPath = song.clips[clipIndex];

  if (!clipPath) {
    setStatus("Song complete. Press Reset to start again.");
    return;
  }

  const token = playbackToken + 1;

  playbackToken = token;
  activeClipIndex = clipIndex;
  isPlaying = true;
  hasQueuedTap = false;
  advancePhraseIndex(song, clipIndex);
  preloadNextClip();
  render();
  setStatus("Loading...");

  try {
    const context = await getPlayerAudioContext();

    if (token !== playbackToken) {
      return;
    }

    const buffer = await loadClipBuffer(clipPath);

    if (token !== playbackToken) {
      return;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRateForPreviousTap(buffer.duration);
    source.connect(context.destination);
    source.onended = () => onPhraseEnded(token);

    stopActiveSource();
    playerEngine.activeSource = source;
    source.start(0);

    activeAudio = {
      duration: buffer.duration,
      playbackRate: source.playbackRate.value,
      stop: () => source.stop(0)
    };

    playbackRateReadout.textContent = `Speed: ${source.playbackRate.value.toFixed(2)}x`;
    setStatus("Playing...");
  } catch (error) {
    if (token !== playbackToken) {
      return;
    }

    isPlaying = false;
    activeClipIndex = null;
    setStatus("Could not play this clip. Check the audio file path.", true);
    render();
  }
}

function onPhraseEnded(token) {
  if (token !== playbackToken) {
    return;
  }

  isPlaying = false;
  activeAudio = null;
  activeClipIndex = null;

  if (hasQueuedTap) {
    hasQueuedTap = false;
    setStatus("Playing queued phrase...");
    render();
    startNextPhrase();
    return;
  }

  if (isComplete) {
    setStatus("Song complete");
  } else {
    setStatus("Ready");
  }

  render();
}

function onAudioError(token) {
  if (token !== playbackToken) {
    return;
  }

  isPlaying = false;
  activeAudio = null;
  activeClipIndex = null;
  hasQueuedTap = false;
  setStatus("Missing audio clip. Add the file or update the song metadata.", true);
  render();
}


async function getPlayerAudioContext() {
  if (!playerEngine.audioContext) {
    playerEngine.audioContext = new AudioContext({ latencyHint: "interactive" });
  }

  if (playerEngine.audioContext.state === "suspended") {
    await playerEngine.audioContext.resume();
  }

  return playerEngine.audioContext;
}

async function loadClipBuffer(clipPath) {
  if (!clipPath) {
    return null;
  }

  if (playerEngine.bufferCache.has(clipPath)) {
    return playerEngine.bufferCache.get(clipPath);
  }

  const context = await getPlayerAudioContext();
  const response = await fetch(clipPath);

  if (!response.ok) {
    throw new Error(`Failed to fetch clip: ${clipPath}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const decoded = await context.decodeAudioData(arrayBuffer);
  playerEngine.bufferCache.set(clipPath, decoded);
  return decoded;
}

function warmClipBuffer(clipPath) {
  loadClipBuffer(clipPath).catch(() => {
    // Ignore warmup failures; the tap-time load will show the real error state.
  });
}

function stopActiveSource() {
  if (!playerEngine.activeSource) {
    return;
  }

  try {
    playerEngine.activeSource.stop(0);
  } catch (error) {
    // Source might already be stopped.
  }

  playerEngine.activeSource.disconnect();
  playerEngine.activeSource = null;
}

function preloadNextClip() {
  const song = getCurrentSong();
  const clip = song.clips[phraseIndex];
  const afterClip = song.clips[phraseIndex + 1];

  warmClipBuffer(clip);
  warmClipBuffer(afterClip);
}

function stopActiveAudio(shouldResetTime = true) {
  if (!activeAudio) {
    isPlaying = false;
    activeClipIndex = null;
    return;
  }

  playbackToken += 1;
  stopActiveSource();
  activeAudio = null;
  isPlaying = false;
  activeClipIndex = null;
  hasQueuedTap = false;
  render();
}

function render() {
  const song = getCurrentSong();
  const total = song.clips.length;
  const currentIndex = activeClipIndex ?? phraseIndex;
  const visiblePhrase = total === 0 ? 0 : Math.min(currentIndex + 1, total);

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

function advancePhraseIndex(song, clipIndex) {
  const nextIndex = clipIndex + 1;

  if (nextIndex >= song.clips.length) {
    if (song.loop) {
      phraseIndex = 0;
      isComplete = false;
      return;
    }

    phraseIndex = song.clips.length;
    isComplete = true;
    return;
  }

  phraseIndex = nextIndex;
  isComplete = false;
}

function setPlaybackMode(mode) {
  if (!["safe", "interrupt", "queue"].includes(mode)) {
    return;
  }

  playbackMode = mode;
  hasQueuedTap = false;
  renderPlaybackMode();
  setStatus(`${modeLabel(mode)} mode`);
  render();
}

function renderPlaybackMode() {
  playbackModeButtons.forEach((button) => {
    const isActive = button.dataset.playbackMode === playbackMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function pulseTapTarget() {
  tapTarget.classList.remove("tap-pulse");
  void tapTarget.offsetWidth;
  tapTarget.classList.add("tap-pulse");
}

function recordTapTiming() {
  const now = performance.now();

  if (lastTapTime) {
    const interval = Math.round(now - lastTapTime);
    tapIntervals.push(interval);
    tapIntervals = tapIntervals.slice(-8);
  }

  lastTapTime = now;
  renderTapTiming();
}

function resetTapTiming() {
  lastTapTime = 0;
  tapIntervals = [];
  playbackRateReadout.textContent = "Speed: 1.00x";
  renderTapTiming();
}

function renderTapTiming() {
  const latest = tapIntervals[tapIntervals.length - 1];

  tapIntervalReadout.textContent = latest ? `Last tap: ${latest} ms` : "Last tap: -- ms";

  if (!tapIntervals.length) {
    tapBpmReadout.textContent = "BPM: --";
    return;
  }

  const average = tapIntervals.reduce((sum, interval) => sum + interval, 0) / tapIntervals.length;
  const bpm = Math.round(60000 / average);
  tapBpmReadout.textContent = `BPM: ${bpm}`;
}

function playbackRateForPreviousTap(naturalSeconds) {
  const latestInterval = tapIntervals[tapIntervals.length - 1];

  if (!latestInterval || !Number.isFinite(naturalSeconds) || naturalSeconds <= 0) {
    return 1;
  }

  const targetSeconds = Math.max(0.08, latestInterval / 1000);
  return clamp(naturalSeconds / targetSeconds, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
}

function modeLabel(mode) {
  return mode[0].toUpperCase() + mode.slice(1);
}

const cutter = {
  fileName: "full-song.mp3",
  objectUrl: "",
  peaks: [],
  duration: 0,
  anchors: [],
  anchorOrder: [],
  generatedKeyframes: [],
  zoomCenter: 0,
  snippetTimer: 0,
  audioContext: null
};

const cutterEls = {
  file: document.querySelector("#song-file"),
  audio: document.querySelector("#cutter-audio"),
  play: document.querySelector("#cutter-play"),
  clock: document.querySelector("#cutter-clock"),
  waveform: document.querySelector("#waveform"),
  zoomWaveform: document.querySelector("#zoom-waveform"),
  zoomRange: document.querySelector("#zoom-range"),
  zoomPlayhead: document.querySelector("#zoom-playhead"),
  addKeyframe: document.querySelector("#add-keyframe"),
  gapSeconds: document.querySelector("#gap-seconds"),
  fillKeyframes: document.querySelector("#fill-keyframes"),
  clearLastKeyframe: document.querySelector("#clear-last-keyframe"),
  clearGeneratedKeyframes: document.querySelector("#clear-generated-keyframes"),
  clearKeyframes: document.querySelector("#clear-keyframes"),
  status: document.querySelector("#cutter-status"),
  snippetList: document.querySelector("#snippet-list"),
  snippetSummary: document.querySelector("#snippet-summary"),
  copyExport: document.querySelector("#copy-export"),
  downloadCsv: document.querySelector("#download-csv"),
  exportOutput: document.querySelector("#export-output")
};

function initializeCutter() {
  cutterEls.file.addEventListener("change", loadCutterFile);
  cutterEls.play.addEventListener("click", toggleCutterPlayback);
  cutterEls.waveform.addEventListener("pointerdown", (event) => seekFromCanvas(event, false));
  cutterEls.zoomWaveform.addEventListener("pointerdown", (event) => seekFromCanvas(event, true));
  cutterEls.zoomRange.addEventListener("input", drawCutterWaveforms);
  cutterEls.zoomPlayhead.addEventListener("click", () => {
    cutter.zoomCenter = cutterEls.audio.currentTime || 0;
    drawCutterWaveforms();
  });
  cutterEls.addKeyframe.addEventListener("click", () => addAnchorAt(cutterEls.audio.currentTime || 0));
  cutterEls.fillKeyframes.addEventListener("click", fillAllAnchors);
  cutterEls.clearLastKeyframe.addEventListener("click", clearLastAnchor);
  cutterEls.clearGeneratedKeyframes.addEventListener("click", clearGeneratedKeyframes);
  cutterEls.clearKeyframes.addEventListener("click", clearAllKeyframes);
  cutterEls.copyExport.addEventListener("click", copyExportText);
  cutterEls.downloadCsv.addEventListener("click", downloadCsv);

  cutterEls.audio.addEventListener("timeupdate", () => {
    cutterEls.clock.textContent = formatMs(cutterEls.audio.currentTime * 1000);
    drawCutterWaveforms();
  });
  cutterEls.audio.addEventListener("play", () => {
    cutterEls.play.textContent = "Pause";
  });
  cutterEls.audio.addEventListener("pause", () => {
    cutterEls.play.textContent = "Play";
  });

  window.addEventListener("resize", drawCutterWaveforms);
  renderSnippets();
}

async function loadCutterFile() {
  const file = cutterEls.file.files[0];

  if (!file) {
    return;
  }

  pauseCutterAudio();
  clearTimeout(cutter.snippetTimer);

  if (cutter.objectUrl) {
    URL.revokeObjectURL(cutter.objectUrl);
  }

  cutter.fileName = file.name || "full-song.mp3";
  cutter.objectUrl = URL.createObjectURL(file);
  cutterEls.audio.src = cutter.objectUrl;
  cutterEls.audio.load();
  cutter.anchors = [];
  cutter.anchorOrder = [];
  cutter.generatedKeyframes = [];
  cutter.peaks = [];
  cutter.duration = 0;
  cutter.zoomCenter = 0;
  setCutterStatus("Decoding waveform...");
  renderSnippets();
  drawCutterWaveforms();

  try {
    const buffer = await file.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    cutter.audioContext = cutter.audioContext || new AudioContextClass();
    const audioBuffer = await cutter.audioContext.decodeAudioData(buffer.slice(0));
    cutter.duration = audioBuffer.duration;
    cutter.peaks = buildPeaks(audioBuffer);
    cutter.zoomCenter = Math.min(cutter.duration, Number(cutterEls.zoomRange.value) / 2);
    setCutterStatus("Ready. Seek, add keyframes, then preview snippets.");
    renderSnippets();
    drawCutterWaveforms();
  } catch (error) {
    setCutterStatus(`Could not decode this audio file: ${error.message}`, true);
  }
}

function buildPeaks(audioBuffer) {
  const channel = audioBuffer.getChannelData(0);
  const bucketCount = 1200;
  const bucketSize = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = [];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    let sum = 0;
    const start = bucket * bucketSize;
    const end = Math.min(channel.length, start + bucketSize);

    for (let index = start; index < end; index += 1) {
      sum += Math.abs(channel[index]);
    }

    peaks.push(Math.min(1, (sum / Math.max(1, end - start)) * 4));
  }

  return peaks;
}

function toggleCutterPlayback() {
  if (!cutterEls.audio.src) {
    setCutterStatus("Load an MP3 first.", true);
    return;
  }

  if (cutterEls.audio.paused) {
    cutterEls.audio.play().catch(() => setCutterStatus("Could not start playback.", true));
  } else {
    pauseCutterAudio();
  }
}

function pauseCutterAudio() {
  if (!cutterEls.audio.paused) {
    cutterEls.audio.pause();
  }
}

function addAnchorAt(seconds, shouldRender = true) {
  if (!hasCutterAudio()) {
    setCutterStatus("Load an MP3 first.", true);
    return;
  }

  const clamped = clamp(seconds, 0, cutter.duration || cutterEls.audio.duration || 0);
  const rounded = Math.round(clamped * 1000) / 1000;

  if (cutter.anchors.some((time) => Math.abs(time - rounded) < 0.025)) {
    setCutterStatus("That anchor is already present.");
    return;
  }

  cutter.generatedKeyframes = cutter.generatedKeyframes.filter((time) => Math.abs(time - rounded) >= 0.025);
  cutter.anchors.push(rounded);
  cutter.anchorOrder.push(rounded);
  cutter.anchors.sort((a, b) => a - b);
  cutter.generatedKeyframes = [];

  if (shouldRender) {
    setCutterStatus(`Added anchor at ${formatMs(rounded * 1000)}. Generated points cleared.`);
  }

  renderSnippets();
  drawCutterWaveforms();
}

function fillAllAnchors() {
  if (!hasCutterAudio()) {
    setCutterStatus("Load an MP3 first.", true);
    return;
  }

  if (cutter.anchors.length < 1) {
    setCutterStatus("Add at least one manual anchor before filling the song.", true);
    return;
  }

  const gap = inferGapSeconds();
  if (!Number.isFinite(gap) || gap <= 0) {
    setCutterStatus("Enter a positive approximate gap.", true);
    return;
  }

  const generated = [];
  const warnings = [];
  const anchors = [...cutter.anchors].sort((a, b) => a - b);
  const duration = cutter.duration || cutterEls.audio.duration || 0;
  const fittedGaps = [];

  addGeneratedKeyframe(generated, 0);

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const start = anchors[index];
    const end = anchors[index + 1];
    const span = end - start;
    const gapCount = Math.max(1, Math.round(span / gap));
    const fittedGap = span / gapCount;
    fittedGaps.push(fittedGap);
    const deviation = Math.abs(fittedGap - gap) / gap;

    if (deviation > 0.12) {
      warnings.push(`${formatMs(start * 1000)}-${formatMs(end * 1000)} uses ${fittedGap.toFixed(3)}s gaps`);
    }

    for (let step = 1; step < gapCount; step += 1) {
      generated.push(Math.round((start + fittedGap * step) * 1000) / 1000);
    }
  }

  const leadingGap = fittedGaps[0] || gap;
  for (let time = anchors[0] - leadingGap; time > 0; time -= leadingGap) {
    addGeneratedKeyframe(generated, time);
  }
  warnOnEdgeRemainder(warnings, "start", anchors[0] % leadingGap, leadingGap, gap);

  const trailingGap = fittedGaps[fittedGaps.length - 1] || gap;
  for (let time = anchors[anchors.length - 1] + trailingGap; time < duration; time += trailingGap) {
    addGeneratedKeyframe(generated, time);
  }
  addGeneratedKeyframe(generated, duration);
  warnOnEdgeRemainder(warnings, "end", (duration - anchors[anchors.length - 1]) % trailingGap, trailingGap, gap);

  cutter.generatedKeyframes = generated;
  renderSnippets();
  drawCutterWaveforms();

  if (warnings.length) {
    setCutterStatus(`Generated ${generated.length} keyframes, but some spans drift from ${gap.toFixed(3)}s: ${warnings.slice(0, 2).join("; ")}.`, true);
    return;
  }

  setCutterStatus(`Generated ${generated.length} keyframes across ${anchors.length} anchors.`);
}

function addGeneratedKeyframe(generated, seconds) {
  const rounded = Math.round(seconds * 1000) / 1000;

  if (rounded < 0 || cutter.anchors.some((time) => Math.abs(time - rounded) < 0.025)) {
    return;
  }

  if (!generated.some((time) => Math.abs(time - rounded) < 0.025)) {
    generated.push(rounded);
  }
}

function warnOnEdgeRemainder(warnings, edge, remainder, fittedGap, approximateGap) {
  const normalizedRemainder = Math.min(remainder, Math.abs(fittedGap - remainder));

  if (normalizedRemainder > 0.05 && Math.abs(normalizedRemainder - approximateGap) / approximateGap > 0.12) {
    warnings.push(`${edge} edge has a ${normalizedRemainder.toFixed(3)}s partial gap`);
  }
}

function inferGapSeconds() {
  const typed = Number(cutterEls.gapSeconds.value);

  if (Number.isFinite(typed) && typed > 0) {
    return typed;
  }

  const frames = allKeyframes();
  const count = frames.length;
  if (count >= 2) {
    return Math.max(0.05, frames[count - 1] - frames[count - 2]);
  }

  return 0.6;
}

function clearLastAnchor() {
  if (!cutter.anchors.length) {
    setCutterStatus("There are no manual anchors to clear.");
    return;
  }

  const removed = cutter.anchorOrder.pop();
  cutter.anchors = cutter.anchors.filter((time) => Math.abs(time - removed) >= 0.025);
  cutter.generatedKeyframes = [];
  setCutterStatus(`Removed anchor at ${formatMs(removed * 1000)}. Generated points cleared.`);
  renderSnippets();
  drawCutterWaveforms();
}

function clearGeneratedKeyframes() {
  if (!cutter.generatedKeyframes.length) {
    setCutterStatus("There are no generated keyframes to clear.");
    return;
  }

  cutter.generatedKeyframes = [];
  setCutterStatus("Generated keyframes cleared. Manual anchors remain.");
  renderSnippets();
  drawCutterWaveforms();
}

function clearAllKeyframes() {
  cutter.anchors = [];
  cutter.anchorOrder = [];
  cutter.generatedKeyframes = [];
  setCutterStatus("All keyframes cleared.");
  renderSnippets();
  drawCutterWaveforms();
}

function seekFromCanvas(event, isZoom) {
  if (!hasCutterAudio()) {
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width);
  const seconds = isZoom
    ? zoomStart() + (x / rect.width) * zoomSpan()
    : (x / rect.width) * Math.max(cutter.duration, cutterEls.audio.duration || 0, 1);

  cutterEls.audio.currentTime = clamp(seconds, 0, cutter.duration || cutterEls.audio.duration || 0);
  cutter.zoomCenter = cutterEls.audio.currentTime;
  drawCutterWaveforms();
}

function drawCutterWaveforms() {
  drawWaveformCanvas(cutterEls.waveform, 0, Math.max(cutter.duration, cutterEls.audio.duration || 0, 1));
  drawWaveformCanvas(cutterEls.zoomWaveform, zoomStart(), zoomStart() + zoomSpan());
}

function drawWaveformCanvas(canvas, startSeconds, endSeconds) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.scale(scale, scale);

  const width = rect.width;
  const height = rect.height;
  const duration = Math.max(cutter.duration, cutterEls.audio.duration || 0, 1);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f9ffff";
  ctx.fillRect(0, 0, width, height);

  drawPeaks(ctx, width, height, startSeconds, endSeconds);

  drawKeyframeMarkers(ctx, width, height, startSeconds, endSeconds, cutter.generatedKeyframes, "#ffd166", 1.5);
  drawKeyframeMarkers(ctx, width, height, startSeconds, endSeconds, cutter.anchors, "#ef6f6c", 3);

  const playhead = cutterEls.audio.currentTime || 0;
  if (playhead >= startSeconds && playhead <= endSeconds) {
    const playX = ((playhead - startSeconds) / Math.max(0.001, endSeconds - startSeconds)) * width;
    ctx.strokeStyle = "#075e73";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height);
    ctx.stroke();
  }

  ctx.fillStyle = "#49646b";
  ctx.font = "12px Consolas, monospace";
  ctx.fillText(`${formatMs(startSeconds * 1000)} - ${formatMs(Math.min(endSeconds, duration) * 1000)}`, 10, height - 10);
}

function drawPeaks(ctx, width, height, startSeconds, endSeconds) {
  const duration = Math.max(cutter.duration, cutterEls.audio.duration || 0, 1);
  const peaks = cutter.peaks.length ? cutter.peaks : new Array(180).fill(0.05);
  const startBucket = Math.max(0, Math.floor((startSeconds / duration) * peaks.length));
  const endBucket = Math.min(peaks.length - 1, Math.ceil((endSeconds / duration) * peaks.length));
  const visible = peaks.slice(startBucket, Math.max(startBucket + 1, endBucket + 1));
  const mid = height / 2;
  const barWidth = width / visible.length;

  visible.forEach((peak, index) => {
    const x = index * barWidth;
    const h = Math.max(2, peak * height * 0.82);
    ctx.fillStyle = index % 2 ? "#1e8ea1" : "#075e73";
    ctx.fillRect(x, mid - h / 2, Math.max(1, barWidth * 0.72), h);
  });
}

function drawKeyframeMarkers(ctx, width, height, startSeconds, endSeconds, keyframes, color, lineWidth) {
  for (const keyframe of keyframes) {
    if (keyframe < startSeconds || keyframe > endSeconds) {
      continue;
    }

    const x = ((keyframe - startSeconds) / Math.max(0.001, endSeconds - startSeconds)) * width;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function zoomSpan() {
  return Number(cutterEls.zoomRange.value) || 12;
}

function zoomStart() {
  const duration = Math.max(cutter.duration, cutterEls.audio.duration || 0, 1);
  const span = Math.min(duration, zoomSpan());
  const center = clamp(cutter.zoomCenter || cutterEls.audio.currentTime || span / 2, span / 2, duration - span / 2);
  return clamp(center - span / 2, 0, Math.max(0, duration - span));
}

function renderSnippets() {
  const snippets = currentSnippets();
  cutterEls.snippetList.innerHTML = "";
  cutterEls.snippetSummary.textContent =
    `${snippets.length} ${snippets.length === 1 ? "clip" : "clips"} | ${cutter.anchors.length} anchors`;

  if (!snippets.length) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "Add an anchor, then use Fill All Anchors to make snippets.";
    cutterEls.snippetList.append(empty);
  }

  snippets.forEach((snippet, index) => {
    const row = document.createElement("div");
    row.className = "snippet-row";

    const info = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = snippet.name;
    detail.textContent = `${formatMs(snippet.start * 1000)} to ${formatMs(snippet.end * 1000)}`;
    info.append(title, detail);

    const playButton = document.createElement("button");
    playButton.className = "secondary-button";
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.addEventListener("click", () => playSnippet(index));

    row.append(info, playButton);
    cutterEls.snippetList.append(row);
  });

  cutterEls.exportOutput.value = buildExportText(snippets);
}

function currentSnippets() {
  const frames = allKeyframes();
  const snippets = [];

  for (let index = 0; index < frames.length - 1; index += 1) {
    const start = frames[index];
    const end = frames[index + 1];

    if (end > start) {
      snippets.push({
        start,
        end,
        name: `${String(index + 1).padStart(3, "0")}.mp3`
      });
    }
  }

  return snippets;
}

function allKeyframes() {
  return [...cutter.anchors, ...cutter.generatedKeyframes]
    .sort((a, b) => a - b)
    .filter((time, index, frames) => index === 0 || Math.abs(time - frames[index - 1]) >= 0.025);
}

function playSnippet(index) {
  const snippet = currentSnippets()[index];

  if (!snippet) {
    return;
  }

  clearTimeout(cutter.snippetTimer);
  cutterEls.audio.currentTime = snippet.start;
  cutter.zoomCenter = snippet.start;
  cutterEls.audio.play().then(() => {
    const durationMs = Math.max(50, (snippet.end - snippet.start) * 1000);
    cutter.snippetTimer = setTimeout(() => {
      pauseCutterAudio();
      cutterEls.audio.currentTime = snippet.end;
      drawCutterWaveforms();
    }, durationMs);
  }).catch(() => setCutterStatus("Could not preview this snippet.", true));
}

function buildExportText(snippets) {
  if (!snippets.length) {
    return "start,end,file\n";
  }

  const csv = buildCsv(snippets);
  const sourceName = cutter.fileName || "full-song.mp3";
  const commands = snippets.map((snippet) => (
    `ffmpeg -i "${sourceName}" -ss ${snippet.start.toFixed(3)} -to ${snippet.end.toFixed(3)} -c:a libmp3lame -q:a 2 "audio/your-song/${snippet.name}"`
  ));

  return `${csv}\n\n${commands.join("\n")}`;
}

function buildCsv(snippets) {
  return [
    "start,end,file",
    ...snippets.map((snippet) => `${snippet.start.toFixed(3)},${snippet.end.toFixed(3)},${snippet.name}`)
  ].join("\n");
}

function copyExportText() {
  const text = cutterEls.exportOutput.value;

  if (!text.trim()) {
    setCutterStatus("There is no export text to copy.", true);
    return;
  }

  navigator.clipboard.writeText(text)
    .then(() => setCutterStatus("Export copied."))
    .catch(() => setCutterStatus("Could not copy export text.", true));
}

function downloadCsv() {
  const snippets = currentSnippets();

  if (!snippets.length) {
    setCutterStatus("Generate snippets before downloading CSV.", true);
    return;
  }

  const blob = new Blob([buildCsv(snippets)], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "slices.csv";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  setCutterStatus("Downloaded slices.csv.");
}

function setCutterStatus(message, isError = false) {
  cutterEls.status.textContent = message;
  cutterEls.status.classList.toggle("error", isError);
}

function hasCutterAudio() {
  return Boolean(cutterEls.audio.src) && Math.max(cutter.duration, cutterEls.audio.duration || 0) > 0;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) {
    return "0:00.000";
  }

  let value = Math.max(0, Math.round(ms));
  const minutes = Math.floor(value / 60000);
  value -= minutes * 60000;
  const seconds = Math.floor(value / 1000);
  const millis = value - seconds * 1000;

  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

initialize();
