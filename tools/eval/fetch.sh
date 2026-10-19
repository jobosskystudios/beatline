#!/bin/bash
# Downloads the evaluation tracks (Creative Commons, from github.com/librosa/data).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)/audio"
mkdir -p "$DIR"
BASE=https://raw.githubusercontent.com/librosa/data/main/audio
for f in \
  Karissa_Hobbs_-_Lets_Go_Fishin.ogg \
  Kevin_MacLeod_-_Vibe_Ace.ogg \
  admiralbob77_-_Choice_-_Drum-bass.ogg \
  442789__lena-orsa__happy-music-pistachio-ice-cream-ragtime.ogg \
  147793__setuniman__sweet-waltz-0i-22mi.ogg \
  Kevin_MacLeod_-_P_I_Tchaikovsky_Dance_of_the_Sugar_Plum_Fairy.ogg \
  5703-47212-0000.ogg \
  "Hungarian_Dance_number_5_-_Allegro_in_F_sharp_minor_(string_orchestra).ogg"; do
  [ -f "$DIR/$f" ] || curl -sSfL -o "$DIR/$f" "$BASE/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$f")"
  echo "$f"
done
