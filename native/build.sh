#!/usr/bin/env bash
# Build engine-sim for the web.
# Env: UPSTREAM (checkout dir, default /tmp/engine-sim), OUT (build dir, default /tmp/esweb),
#      EMSDK (emsdk dir, used if em++ is not on PATH), CLANG_EXTRA (extra flags for the native build)
#   ./build.sh native   -> native smoke-test binary
#   ./build.sh web      -> ../web/engine.js + engine.wasm + engine.data
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="${UPSTREAM:-/tmp/engine-sim}"
OUT="${OUT:-/tmp/esweb}"
MODE="${1:-web}"

if [ ! -d "$UP" ]; then
  git clone --recursive https://github.com/ange-yaghi/engine-sim "$UP"
  git -C "$UP" checkout 85f7c3b
  git -C "$UP" submodule update --init --recursive
fi
python3 "$HERE/patch_upstream.py" "$UP"

PIR="$UP/dependencies/submodules/piranha"
SCS="$UP/dependencies/submodules/simple-2d-constraint-solver"
mkdir -p "$OUT/gen" "$OUT/obj-$MODE"
if [ ! -f "$OUT/gen/parser.auto.cpp" ]; then
  flex --header-file="$OUT/gen/scanner.auto.h" -o "$OUT/gen/scanner.auto.cpp" "$PIR/flex-bison/scanner.l"
  bison --defines="$OUT/gen/parser.auto.h" -o "$OUT/gen/parser.auto.cpp" "$PIR/flex-bison/specification.y"
fi

CORE=$(sed -n '/add_library(engine-sim STATIC/,/# Include files/p' "$UP/CMakeLists.txt" | grep -o 'src/[a-z_0-9]*\.cpp' | sed "s#^#$UP/#")
SCRIPT=$(ls "$UP"/scripting/src/*.cpp)
PIRSRC="$(ls "$PIR"/src/*.cpp) $OUT/gen/parser.auto.cpp $OUT/gen/scanner.auto.cpp"
SCSSRC=$(ls "$SCS"/src/*.cpp)
SRCS="$CORE $SCRIPT $PIRSRC $SCSSRC $HERE/bridge.cpp"

INC="-I$UP -I$UP/include -I$UP/scripting/include -I$UP/dependencies/submodules -I$PIR/include -I$PIR/dependencies/libraries/flex/include -I$OUT/gen -I$SCS/include"
DEFS="-include $HERE/compat.h -DATG_ENGINE_SIM_PIRANHA_ENABLED -DESWEB_SINGLE_THREAD -DNDEBUG"

if [ "$MODE" = native ]; then
  CXX=clang++; FLAGS="${CLANG_EXTRA:-} -O2 -std=c++17 -w"
else
  if ! command -v em++ >/dev/null; then
    [ -f "${EMSDK:-/tmp/emsdk}/emsdk_env.sh" ] && source "${EMSDK:-/tmp/emsdk}/emsdk_env.sh" >/dev/null 2>&1
  fi
  CXX=em++; FLAGS="-O3 -std=c++17 -w -fexceptions -msimd128 -flto"
fi

objname() { echo "$OUT/obj-$MODE/$(echo "$1" | md5sum | cut -c1-8)_$(basename "$1" .cpp).o"; }
OBJS=()
for s in $SRCS; do OBJS+=("$(objname "$s")"); done
for s in $SRCS; do
  o="$(objname "$s")"
  if [ ! -f "$o" ] || [ "$s" -nt "$o" ]; then
    echo "$CXX $FLAGS $DEFS $INC -c $s -o $o"
  fi
done | xargs -P "$(nproc)" -I{} sh -c '{}'

if [ "$MODE" = native ]; then
  clang++ ${CLANG_EXTRA:-} "${OBJS[@]}" -o "$OUT/bridge-test" -lpthread
  echo "built $OUT/bridge-test"
else
  STAGE="$OUT/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -r "$UP/es" "$STAGE/es"
  mkdir -p "$STAGE/assets"
  cp -r "$UP/assets/." "$STAGE/assets/"
  find "$STAGE" -type f ! -name '*.mr' ! -name '*.wav' -delete
  rm -f "$STAGE/assets/web_main.mr"
  rm -rf "$STAGE/assets/sound-library"   # unused by the bundled scripts (es/sound-library is used)
  cd "$HERE/../web"
  em++ "${OBJS[@]}" -o engine.js -O3 -flto -msimd128 -fexceptions \
    -sMODULARIZE=1 -sEXPORT_NAME=EngineSimModule -sENVIRONMENT=worker \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
    -sEXPORTED_RUNTIME_METHODS=FS,cwrap,UTF8ToString,stringToNewUTF8,HEAP16,HEAPF64 \
    -sEXPORTED_FUNCTIONS=_malloc,_free \
    --preload-file "$STAGE/es@/es" --preload-file "$STAGE/assets@/assets"
  ls -la engine.*
fi
