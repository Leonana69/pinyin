'use strict';

/* 口 kǒu
   A typed word becomes a grid of mouths, one per pinyin letter. Every card is
   painted on a single canvas from a sheet holding all of its letter's frames,
   and every sound is scheduled through Web Audio on one clock. Neither has a
   cap the way video players do (browsers stop at about 75 a page), so a
   sentence can run to hundreds of cards, and the overlaps land exactly. */

const CONFIG = {
  overlap: 1,           // seconds: the next clip starts this long before the current one ends;
                        // a clip shorter than this overlaps for its whole length
  lead: 0.15,           // seconds from pressing Enter to the first sound, so nothing is scheduled late
  slideDuration: 0.75,  // seconds: the grid sliding away when the next word starts
  maxCards: 300,
  umlautClip: 'v',      // ü has no clip of its own; v is how pinyin keyboards type it
  sheetMemoryMB: 400,   // most memory a word's frames may take once unpacked; bigger frames step down to fit
  sheetPath: (size, letter) => `assets/sheets/${size}/${letter}.jpg`,
  soundPath: (letter) => `assets/sound/${letter}.m4a`,
  labelFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  wordLine: 14,         // characters per line of the typed word before it wraps
  wordTracking: 0.2,    // extra space after each character of the typed word, in em (20%)
  wordLeading: 1.2,     // line height of the typed word, against its size (20% more than solid)
  readoutOpen: 0.3,     // seconds for the pinyin line to slide open or shut

  // Seconds into each clip where the mouth is most fully formed. With reduced
  // motion, cards stop on this frame once the word is said instead of looping.
  restFrames: {
    a: 0.36, b: 0.4, c: 0.27, d: 0.4, e: 0.37, f: 0.4, g: 0.43, h: 0.14, i: 0.3,
    j: 0.35, k: 0.9, l: 0.57, m: 0.54, n: 0.4, o: 0.36, p: 0.33, q: 0.64, r: 0.4,
    s: 0.5, t: 0.44, u: 0.36, v: 0.63, w: 0.53, x: 0.6, y: 0.3, z: 0.5,
  },
};

const body = document.body;
const form = document.getElementById('composer');
const input = document.getElementById('word');
const stage = document.getElementById('stage');
const readout = document.getElementById('readout');
const hudTop = document.querySelector('.hud-top');
const hudBottom = document.querySelector('.hud-bottom');
const canHover = matchMedia('(hover: hover)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SIZES = Object.keys(SHEETS.tiers).map(Number).sort((a, b) => a - b);  // frame widths on offer

document.documentElement.style.setProperty('--slide', `${CONFIG.slideDuration}s`);
document.documentElement.style.setProperty('--word-tracking', `${CONFIG.wordTracking}em`);
document.documentElement.style.setProperty('--word-leading', CONFIG.wordLeading);

const audio = new (window.AudioContext || window.webkitAudioContext)();
let current = null; // the run on stage

/* ── Hanzi → letters ─────────────────────────────────── */

function toLetter(glyph) {
  const decomposed = glyph.normalize('NFD');
  const base = decomposed[0].toLowerCase();
  if (!/[a-z]/.test(base)) return null;
  return { glyph, clip: decomposed.includes('̈') ? CONFIG.umlautClip : base };
}

function decompose(text) {
  return pinyinPro.pinyin(text, { type: 'array' })
    .map((syllable) => [...syllable].map(toLetter).filter(Boolean))
    .filter((letters) => letters.length);
}

/* ── Pinyin line ─────────────────────────────────────── */

// One line, cut off with an ellipsis; hovering or clicking shows all of it.
function renderReadout(syllables) {
  const spans = [];
  readoutMotion?.cancel();
  readout.classList.remove('open');
  readout.dataset.open = 'false';
  readout.replaceChildren(...syllables.flatMap((letters, n) => {
    const word = document.createElement('span');
    for (const { glyph } of letters) {
      const span = document.createElement('i');
      span.textContent = glyph;
      word.append(span);
      spans.push(span);
    }
    return n ? [' ', word] : [word];  // real spaces, so the full view can wrap between syllables
  }));
  markCut();
  return spans;
}

// Whether the pinyin runs past one line: measured with the lines laid out in full.
function markCut() {
  if (readout.dataset.open === 'true') return;
  readout.classList.add('open');
  const lines = readout.scrollHeight / parseFloat(getComputedStyle(readout).lineHeight);
  readout.classList.remove('open');
  readout.toggleAttribute('data-cut', lines > 1.5);
}

// The extra lines slide open upwards from the one shown, and back down.
let readoutMotion = null;

function setReadoutOpen(open) {
  if (String(open) === readout.dataset.open || (open && !readout.hasAttribute('data-cut'))) return;
  readout.dataset.open = String(open);

  const from = readout.getBoundingClientRect().height;
  readoutMotion?.cancel();
  readout.classList.add('open');  // every line laid out while it moves
  const to = open ? readout.scrollHeight : parseFloat(getComputedStyle(readout).lineHeight);

  const motion = readoutMotion = readout.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: reducedMotion.matches ? 1 : CONFIG.readoutOpen * 1000, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' },
  );
  motion.onfinish = () => {
    if (!open) readout.classList.remove('open');  // back to one line with its ellipsis
    motion.cancel();                              // the height follows the text again
    if (readoutMotion === motion) readoutMotion = null;
  };
}

function showNote(text) {
  const note = document.createElement('span');
  note.className = 'note';
  note.textContent = ` ${text}`;
  readout.append(note);
  markCut();
}

// A mouse opens it by hovering; a finger by tapping, and tapping elsewhere shuts it.
// Moving, not just entering, opens it: the pointer may already be resting where a new line appears.
readout.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse') setReadoutOpen(true); });
readout.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse') setReadoutOpen(false); });
readout.addEventListener('click', () => {
  if (!canHover.matches) setReadoutOpen(readout.dataset.open !== 'true');
});
document.addEventListener('click', (event) => {
  if (!canHover.matches && !readout.contains(event.target)) setReadoutOpen(false);
});

/* ── Letters: frame sheets and sounds ────────────────── */

const sheets = new Map();  // 'size/letter' → unpacked frame sheet
const sounds = new Map();  // letter → decoded sound

function fetchOk(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response;
  });
}

function cached(map, key, load) {
  if (!map.has(key)) {
    const loading = load();
    loading.catch(() => map.delete(key));  // a later word can try again
    map.set(key, loading);
  }
  return map.get(key);
}

const loadSheet = (size, letter) => cached(sheets, `${size}/${letter}`, () =>
  fetchOk(CONFIG.sheetPath(size, letter)).then((r) => r.blob()).then((blob) => createImageBitmap(blob)));

const loadSound = (letter) => cached(sounds, letter, () =>
  fetchOk(CONFIG.soundPath(letter)).then((r) => r.arrayBuffer()).then((data) => audio.decodeAudioData(data)));

// Unpacked frames are large, so only the current word's are kept.
function forgetSheetsExcept(keep) {
  for (const [key, loading] of sheets) {
    if (keep.has(key)) continue;
    sheets.delete(key);
    loading.then((sheet) => sheet.close(), () => {});
  }
}

// The smallest frames that fill a card on this screen, stepped down if the
// word's letters would take more memory than the budget allows.
function frameSize(cellW, letters) {
  const needed = cellW * (window.devicePixelRatio || 1) * 0.9;  // a slight stretch is invisible
  let index = SIZES.findIndex((size) => size >= needed);
  if (index < 0) index = SIZES.length - 1;
  const bytes = (size) => letters.reduce((sum, l) => sum + SHEETS.frames[l] * size * (size * 3 / 4) * 4, 0);
  while (index > 0 && bytes(SIZES[index]) > CONFIG.sheetMemoryMB * 1e6) index -= 1;
  return SIZES[index];
}

// Browsers keep sound off until a click or key press; this runs inside one.
function unlockAudio() {
  if (audio.state !== 'running') audio.resume();
  const blip = audio.createBufferSource();  // iPhones also want a sound started in the gesture
  blip.buffer = audio.createBuffer(1, 1, audio.sampleRate);
  blip.connect(audio.destination);
  blip.start();
}

// The audio clock at the moment the speakers are actually sounding, so the
// pictures line up with what is heard rather than with what was scheduled.
function heardTime() {
  if (audio.getOutputTimestamp) {
    const { contextTime, performanceTime } = audio.getOutputTimestamp();
    if (performanceTime) return contextTime + (performance.now() - performanceTime) / 1000;
  }
  return audio.currentTime - (audio.outputLatency || audio.baseLatency || 0);
}

/* ── Stage ───────────────────────────────────────────── */

// The grid that gives the biggest cards for this many clips in the space
// available, so a long sentence fills about the same area as a short word.
// Spare cells stay empty at the end; when two shapes give equally big cards,
// the one with fewer empty cells wins (4 clips: 2×2, 11 or 12: 3×4).
function planGrid(count) {
  const { clientWidth: width, clientHeight: height } = stage;
  const side = parseFloat(getComputedStyle(hudTop).paddingLeft);
  const clear = Math.max(hudTop.getBoundingClientRect().bottom, height - hudBottom.getBoundingClientRect().top);
  const boxW = width - side * 2;
  const boxH = Math.max(height - clear * 2, height / 2);

  let best = null;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const unit = Math.min(boxW / (cols * 4), boxH / (rows * 3));  // the footage is 4:3
    const empty = cols * rows - count;
    const bigger = !best || unit > best.unit * (1 + 1e-9);
    const same = best && Math.abs(unit - best.unit) <= best.unit * 1e-9;
    if (bigger || (same && empty < best.empty)) best = { cols, rows, unit, empty };
  }

  // Whole pixels, so neighbouring cards meet without a hairline between them.
  const cellW = Math.floor(best.unit * 4);
  const cellH = Math.floor(best.unit * 3);
  return {
    cols: best.cols,
    rows: best.rows,
    cellW,
    cellH,
    x: Math.round((width - best.cols * cellW) / 2),
    y: Math.round((height - best.rows * cellH) / 2),
  };
}

function layoutGrid(run) {
  Object.assign(run, planGrid(run.cards.length));
  const { canvas, cols, rows, cellW, cellH } = run;

  // Sharp on high-density screens: the canvas has a pixel for every screen pixel.
  const density = window.devicePixelRatio || 1;
  canvas.style.width = `${cols * cellW}px`;
  canvas.style.height = `${rows * cellH}px`;
  canvas.width = Math.round(cols * cellW * density);
  canvas.height = Math.round(rows * cellH * density);
  run.paint.setTransform(density, 0, 0, density, 0, 0);
  canvas.style.transform = `translate3d(${run.x}px, ${run.y}px, 0)`;
}

// One pass over every card, once per screen refresh. Each card shows the frame
// for how long ago its sound began, so after its first pass it simply loops.
function paint(run) {
  if (run.dead) return;
  const now = heardTime();
  const resting = now >= run.end;
  const { paint: g, cols, rows, cellW, cellH, size } = run;
  const tileW = size;
  const tileH = size * 3 / 4;
  const sheetCols = SHEETS.tiers[size].cols;
  const { fps } = SHEETS;

  g.clearRect(0, 0, cols * cellW, rows * cellH);
  g.imageSmoothingQuality = 'high';
  g.font = `500 ${cellH * 0.11}px ${CONFIG.labelFont}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';

  run.cards.forEach((card, i) => {
    const speaking = now >= card.start && now < card.end;
    if (speaking !== card.speaking) {
      card.speaking = speaking;
      run.spans[i].classList.toggle('on', speaking);
    }
    if (now < card.start) return;  // the cell stays empty until its sound begins

    const frames = SHEETS.frames[card.clip];
    let frame = Math.floor((now - card.start) * fps) % frames;
    if (resting && reducedMotion.matches) frame = Math.min(frames - 1, Math.round(CONFIG.restFrames[card.clip] * fps));

    // Inset by a pixel so smoothing never pulls in the edge of the neighbouring frame.
    const sx = (frame % sheetCols) * tileW + 1;
    const sy = Math.floor(frame / sheetCols) * tileH + 1;
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    g.drawImage(card.sheet, sx, sy, tileW - 2, tileH - 2, x, y, cellW, cellH);
    g.fillText(card.glyph, x + cellW / 2, y + cellH / 2);
  });

  if (resting && body.dataset.state === 'playing') body.dataset.state = 'rest';
  run.raf = requestAnimationFrame(() => paint(run));
}

function dismiss(run) {
  if (!run) return;
  run.dead = true;
  cancelAnimationFrame(run.raf);
  run.sources.forEach((source) => source.stop());

  const right = run.canvas.getBoundingClientRect().right;
  run.canvas.style.transform = `translate3d(${-right - 40}px, 0, 0) ${run.canvas.style.transform}`;
  setTimeout(() => run.canvas.remove(), CONFIG.slideDuration * 1000);
}

/* ── Sequencing ──────────────────────────────────────── */

function perform(text) {
  const syllables = decompose(text);
  const letters = syllables.flat().slice(0, CONFIG.maxCards);

  if (!letters.length) {
    renderReadout([]);
    if (text.trim()) showNote('没有拼音 · No pinyin for this');
    return;
  }

  dismiss(current);
  unlockAudio();

  const canvas = document.createElement('canvas');
  canvas.className = 'board';
  const run = current = {
    canvas,
    paint: canvas.getContext('2d'),
    cards: letters.map((letter) => ({ ...letter, start: Infinity, end: Infinity, speaking: false })),
    spans: renderReadout(syllables),
    sources: [],
    end: Infinity,
    dead: false,
    raf: 0,
  };

  layoutGrid(run);
  stage.append(canvas);
  body.dataset.state = 'playing';
  armForNextWord();

  const needed = [...new Set(letters.map(({ clip }) => clip))];
  run.size = frameSize(run.cellW, needed);
  forgetSheetsExcept(new Set(needed.map((letter) => `${run.size}/${letter}`)));

  // Every sound is scheduled up front on the audio clock, so overlaps are exact
  // however busy the page gets.
  Promise.all(needed.map((letter) => Promise.all([loadSheet(run.size, letter), loadSound(letter)]))).then((loaded) => {
    if (run.dead) return;
    const byLetter = new Map(needed.map((letter, i) => [letter, loaded[i]]));

    let when = audio.currentTime + CONFIG.lead;
    for (const card of run.cards) {
      const [sheet, sound] = byLetter.get(card.clip);
      const length = SHEETS.frames[card.clip] / SHEETS.fps;
      card.sheet = sheet;
      card.start = when;
      card.end = when + length;

      const source = audio.createBufferSource();
      source.buffer = sound;
      source.connect(audio.destination);
      source.start(when);
      run.sources.push(source);

      when += length - Math.min(CONFIG.overlap, length);
    }
    run.end = Math.max(...run.cards.map((card) => card.end));
    paint(run);
  }, (error) => {
    console.error(error);
    if (!run.dead) showNote('素材加载失败 · The letters couldn’t load');
  });
}

/* ── Input ───────────────────────────────────────────── */

function armForNextWord() {
  if (!canHover.matches) return;
  input.focus();
  input.select();
}

// Hanzi are a full em wide, Latin about half, each plus the letter spacing.
// The word wraps every 14 Hanzi, and its size is the largest at which those
// lines fit the screen.
function fitText() {
  const { wordLine, wordTracking: gap } = CONFIG;
  const width = [...input.value].reduce((sum, c) => sum + (c.charCodeAt(0) > 0x2e7f ? 1 : 0.56) + gap, 0);
  const line = wordLine * (1 + gap);
  input.style.setProperty('--per-line', Math.max(1 + gap, Math.min(width, line) * 1.04) + gap);
  input.style.setProperty('--lines', Math.max(1, Math.ceil(width / line)));
  input.style.height = '0px';
  input.style.height = `${input.scrollHeight}px`;  // punctuation can push a line over, so measure
}

function onType() {
  dismiss(current);
  current = null;
  fitText();
  renderReadout(decompose(input.value));
  body.dataset.state = input.value ? 'typing' : 'idle';
}

input.addEventListener('input', () => {
  if (input.value.includes('\n')) input.value = input.value.replace(/\n/g, '');  // pasted line breaks
  onType();
});

// Enter plays the word, as it did when this was a one-line field; not while an
// input method is still composing characters.
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  form.requestSubmit();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  perform(input.value);
});

document.getElementById('home').addEventListener('click', () => {
  input.value = '';
  onType();
  if (canHover.matches) input.focus();
});

document.querySelectorAll('[data-word]').forEach((button) => {
  button.addEventListener('click', () => {
    input.value = button.dataset.word;
    onType();
    perform(input.value);
  });
});

// The word no longer fills the page, so a click anywhere else still lands in it.
document.addEventListener('pointerup', (event) => {
  if (current) armForNextWord();
  else if (canHover.matches && !event.target.closest('button, .readout, textarea')) input.focus();
});

window.addEventListener('resize', () => {
  fitText();
  markCut();
  if (current) layoutGrid(current);
});

fitText();
