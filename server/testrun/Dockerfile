# Test-run image: Python 3.11 + Demucs + Basic Pitch + YourMT3+ deps + librosa. Code is mounted at run time (see docker-run.sh).
FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TORCH_HOME=/opt/torch NUMBA_CACHE_DIR=/tmp/numba HOME=/tmp
RUN pip install --index-url https://download.pytorch.org/whl/cu126 torch==2.8.0 torchaudio==2.8.0
COPY requirements-testrun.txt /tmp/requirements-testrun.txt
RUN pip install -r /tmp/requirements-testrun.txt
# Bake the Demucs weights in so runs need no network.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')" && chmod -R a+rX /opt/torch
# YourMT3+ (torch inductor needs a user name; the container runs as the host uid with no passwd entry)
ENV USER=gb LOGNAME=gb TORCHINDUCTOR_CACHE_DIR=/tmp/inductor WANDB_MODE=disabled
WORKDIR /app
