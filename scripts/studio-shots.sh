#!/bin/sh
# Screenshots of every studio screen (desktop 1440×900 and phone 390×844) for the canvas page «Студия сейчас».
# Usage: scripts/studio-shots.sh <studio url, e.g. http://localhost:8080> <WEB_KEY> <out dir>
set -e
BASE=$1; KEY=$2; OUT=${3:-shots}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
REEL=${REEL:-$(curl -s -c /tmp/studio-shots.jar -o /dev/null "$BASE/?k=$KEY"; curl -s -b /tmp/studio-shots.jar "$BASE/api/overview" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).reels;console.log((r.find(x=>x.version)||r[0]).id)})')}
mkdir -p "$OUT"
shot() { # name width height route
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=$2,$3 --virtual-time-budget=6000 \
    --screenshot="$OUT/$1.png" "$BASE/?k=$KEY$4" >/dev/null 2>&1
  echo "$OUT/$1.png"
}
POST=${POST:-$(curl -s -b /tmp/studio-shots.jar "$BASE/api/overview" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).posts||[];console.log((p.find(x=>x.kind==="carousel")||{}).id||"")})')}
PHOTO=${PHOTO:-$(curl -s -b /tmp/studio-shots.jar "$BASE/api/overview" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).posts||[];console.log((p.find(x=>x.kind!=="carousel")||{}).id||"")})')}
for v in "today:#/" "all:#/all" "all-reels:#/all/reels" "all-posts:#/all/posts" "reel-script:#/reel/$REEL/script" "reel-materials:#/reel/$REEL/materials" "reel:#/reel/$REEL/edit" "reel-publish:#/reel/$REEL/publish" "new:#/new" "strategy:#/knowledge" "settings-ds:#/settings/ds" "settings-files:#/settings/files" "settings-access:#/settings/access" \
  ${PHOTO:+"post-text:#/post/$PHOTO/text"} ${POST:+"carousel-struct:#/post/$POST/struct"} ${POST:+"carousel-slides:#/post/$POST/slides"} ${POST:+"carousel-publish:#/post/$POST/publish"}; do
  shot "desk-${v%%:*}" 1440 900 "${v#*:}"
done
for v in "today:#/" "all:#/all" "reel:#/reel/$REEL"; do
  shot "phone-${v%%:*}" 390 844 "${v#*:}"
done
