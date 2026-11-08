#!/usr/bin/env bash
# Run the test run in Docker. Same arguments as run.py, e.g.:  server/testrun/docker-run.sh comfortably-numb
# Build once (or after changing requirements):  server/testrun/docker-run.sh --build
# Find solo/riff sections of a whole song:       server/testrun/docker-run.sh --sections shesmovedon
#
# - The music folder is mounted read-only (:ro); the container cannot write there.
# - SELinux: we use label=disable and NEVER :z/:Z. Those relabel the mounted folder, and the music folder carries
#   the music server's own container label; relabelling it could break the music server.
# - GPU is used only when the NVIDIA Container Toolkit is installed (and the driver is loaded); otherwise CPU.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=guitar-buddy-testrun
MUSIC="${GB_MUSIC_DIR:-/mnt/workspace/music-server/downloads/complete}"
WORK="${GB_WORK_DIR:-/srv/guitar-buddy/work}"

if [[ "${1:-}" == "--build" ]]; then
  exec docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE/.."
fi

script=/app/run.py
if [[ "${1:-}" == "--sections" ]]; then script=/app/sections.py; shift; fi  # find solo/riff sections

gpu=()
if command -v nvidia-ctk >/dev/null && nvidia-smi >/dev/null 2>&1; then gpu=(--gpus all); fi
mkdir -p "$WORK"
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --security-opt label=disable \
  "${gpu[@]}" \
  -v "$MUSIC:$MUSIC:ro" \
  -v "$WORK:$WORK" \
  -v "$HERE:/app:ro" \
  -e GB_MUSIC_DIR="$MUSIC" -e GB_WORK_DIR="$WORK" \
  "$IMAGE" python "$script" "$@"
