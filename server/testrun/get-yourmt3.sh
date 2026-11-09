#!/usr/bin/env bash
# Download YourMT3+ (code + the YPTF.MoE+Multi noPS checkpoint, ~560 MB) from its public Hugging Face Space
# into GB_YMT3_DIR (default /srv/guitar-buddy/models/yourmt3). Not part of the repo. Free, no token needed.
set -euo pipefail
D="${GB_YMT3_DIR:-/srv/guitar-buddy/models/yourmt3}"
B=https://huggingface.co/spaces/mimbres/YourMT3/resolve/main
E=mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops
mkdir -p "$D" && cd "$D"
curl -sfL -m 60 https://huggingface.co/api/spaces/mimbres/YourMT3 | python3 -c '
import json, sys
fs = [s["rfilename"] for s in json.load(sys.stdin)["siblings"]]
print("\n".join(f for f in fs if f.startswith("amt/src/") and f.endswith(".py")
                and not any(x in f for x in ("/extras/", "/tests/", "/preprocess/", "/mirdata_dev/"))))' > srclist.txt
for f in $(cat srclist.txt) model_helper.py; do mkdir -p "$(dirname "$f")"; curl -sfL -m 60 "$B/$f" -o "$f"; done
mkdir -p "amt/logs/2024/$E/checkpoints"
[[ -s "amt/logs/2024/$E/checkpoints/last.ckpt" ]] || curl -fL -m 1800 "$B/amt/logs/2024/$E/checkpoints/last.ckpt" -o "amt/logs/2024/$E/checkpoints/last.ckpt"
echo "YourMT3+ ready in $D"
