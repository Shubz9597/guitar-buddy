#!/usr/bin/env bash
# Run the test run in Docker. Same arguments as run.py, e.g.:  server/testrun/docker-run.sh comfortably-numb
# Build once (or after changing requirements):  server/testrun/docker-run.sh --build
# Find solo/riff sections of a whole song:       server/testrun/docker-run.sh --sections shesmovedon
#
# - The music folder is mounted read-only (:ro); the container cannot write there.
# - SELinux: we use label=disable and NEVER :z/:Z. Those relabel the mounted folder, and the music folder carries
#   the music server's own container label; relabelling it could break the music server.
# - GPU is used only when the NVIDIA Container Toolkit is installed (and the driver is loaded); otherwise CPU.
# - MuScriptor (default transcriber when set up) runs in its own image (it needs numpy 2, basic-pitch numpy 1):
#   run.py --prepare makes the stems and leaves a job, MuScriptor runs, then run.py builds the tab.
#   "Set up" = image guitar-buddy-muscriptor exists and the owner's Hugging Face token is in $MODELS/hf_token
#   (its weights are gated, CC BY-NC 4.0). Without it, run.py falls back to YourMT3+ (riffs) / Basic Pitch (leads).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=guitar-buddy-testrun
MUS_IMAGE=guitar-buddy-muscriptor
MUSIC="${GB_MUSIC_DIR:-/mnt/workspace/music-server/downloads/complete}"
WORK="${GB_WORK_DIR:-/srv/guitar-buddy/work}"
MODELS="${GB_MODELS_DIR:-/srv/guitar-buddy/models}"  # YourMT3+ (get-yourmt3.sh), MuScriptor cache + hf_token

if [[ "${1:-}" == "--build" ]]; then
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE/.."
  exec docker build -t "$MUS_IMAGE" -f "$HERE/Dockerfile.muscriptor" "$HERE"
fi

script=/app/run.py
if [[ "${1:-}" == "--sections" ]]; then script=/app/sections.py; shift; fi  # find solo/riff sections

gpu=()
if command -v nvidia-ctk >/dev/null && nvidia-smi >/dev/null 2>&1; then gpu=(--gpus all); fi
mkdir -p "$WORK" "$MODELS/hf-cache"
musc=0
if [[ -s "$MODELS/hf_token" ]] && docker image inspect "$MUS_IMAGE" >/dev/null 2>&1; then musc=1; fi
base=(docker run --rm --init --user "$(id -u):$(id -g)" --security-opt label=disable "${gpu[@]}"
      -v "$MUSIC:$MUSIC:ro" -v "$WORK:$WORK" -v "$HERE:/app:ro" -v "$MODELS:$MODELS:ro"
      -e GB_MUSIC_DIR="$MUSIC" -e GB_WORK_DIR="$WORK" -e GB_YMT3_DIR="$MODELS/yourmt3" -e GB_MUSCRIPTOR="$musc")

if [[ "$script" == /app/run.py && "$musc" == 1 ]]; then
  job="$WORK/.muscriptor_job.json"
  rm -f "$job"
  "${base[@]}" "$IMAGE" python "$script" "$@" --prepare
  if [[ -f "$job" ]]; then
    read -r input output model instruments < <(python3 -c 'import json,sys; j=json.load(open(sys.argv[1]))
print(j["input"], j["output"], j["model"], j["instruments"])' "$job")
    echo "[muscriptor] $model on $(basename "$input") ..."
    docker run --rm --init --user "$(id -u):$(id -g)" --security-opt label=disable "${gpu[@]}" \
      -v "$WORK:$WORK" -v "$MODELS/hf_token:/run/hf_token:ro" -e HF_TOKEN_PATH=/run/hf_token \
      -v "$MODELS/hf-cache:/hf" -e HF_HOME=/hf \
      "$MUS_IMAGE" muscriptor transcribe "$input" -m "$model" -d auto -f json -o "$output.tmp" \
      --detect-tempo false --instruments "$instruments" 2>&1 | grep -E "transcribe total|Error|error" || true
    [[ -s "$output.tmp" ]] || { echo "MuScriptor produced no output" >&2; exit 1; }
    mv "$output.tmp" "$output"
    python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); json.dump(j["params"], open(j["params_file"], "w"))' "$job"
    rm -f "$job"
  fi
fi
exec "${base[@]}" "$IMAGE" python "$script" "$@"
