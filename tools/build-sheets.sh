#!/bin/zsh
# Frame sheets and sound files for the site, from the trimmed alphabet clips.
# Each sheet holds every frame of one letter. Several sizes are made so small cards
# load small frames and big cards stay sharp; sheets stay within 4096 px wide.
set -e
cd "${1:-$(dirname "$0")/..}"
L=abcdefghijklmnopqrstuvwxyz
TIERS=(192 384 576 768)
rm -f assets/sheets/*.jpg
mkdir -p assets/sheets assets/sound
frames=""; tiers=""
for t in $TIERS; do
  cols=$(( 4096 / t )); (( cols > 8 )) && cols=8
  tiers="$tiers $t: { cols: $cols },"
  mkdir -p assets/sheets/$t
done
for i in $(seq 1 26); do
  l=${L:$((i-1)):1}; src=assets/alphabet/alphabet-$i.mp4
  n=$(ffmpeg -nostdin -i $src -map 0:v:0 -c copy -f null - 2>&1 | grep -oE 'frame= *[0-9]+' | tail -1 | tr -dc 0-9)
  frames="$frames $l: $n,"
  for t in $TIERS; do
    cols=$(( 4096 / t )); (( cols > 8 )) && cols=8
    rows=$(( (n + cols - 1) / cols ))
    ffmpeg -nostdin -hide_banner -loglevel error -y -i $src \
      -vf "scale=${t}:$(( t * 3 / 4 )):flags=lanczos,tile=${cols}x${rows}" -frames:v 1 -q:v 3 assets/sheets/$t/$l.jpg
  done
  ffmpeg -nostdin -hide_banner -loglevel error -y -i $src -map 0:a:0 -c:a copy -map_metadata -1 -movflags +faststart assets/sound/$l.m4a
done
echo "window.SHEETS = { fps: 30, tiers: {$tiers }, frames: {$frames } };" > assets/sheets/manifest.js
