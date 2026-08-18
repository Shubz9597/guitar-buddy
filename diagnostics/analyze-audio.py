import json
import math
import sys

import numpy as np


def median(values):
    return float(np.median(np.asarray(values, dtype=np.float64)))


def estimate_tempo(intervals_ms, attacks_per_beat):
    valid = np.asarray(
        [value for value in intervals_ms if 60 <= value <= 3000],
        dtype=np.float64,
    )
    if len(valid) == 0:
        return None

    ordered = np.sort(valid)
    lower_half = ordered[: max(1, math.ceil(len(ordered) / 2))]
    initial_center = median(lower_half)

    def normalize_around(center, tolerance):
        samples = []
        for interval in valid:
            missed = max(1, min(8, round(interval / center)))
            normalized = interval / missed
            relative_error = abs(normalized - center) / max(center, 1)
            if relative_error <= tolerance:
                samples.append(normalized)
        return samples

    first_pass = normalize_around(initial_center, 0.28)
    refined_center = median(first_pass) if first_pass else median(valid)
    refined = normalize_around(refined_center, 0.22)
    interval = median(refined if refined else valid)
    return 60000 / (interval * attacks_per_beat), interval


def main():
    pcm_path = sys.argv[1]
    metadata_path = f"{pcm_path}.json"
    with open(metadata_path, "r", encoding="utf-8") as handle:
        metadata = json.load(handle)

    sample_rate = int(metadata["sampleRate"])
    audio = np.fromfile(pcm_path, dtype=np.float32).astype(np.float64)
    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio /= peak

    frame_size = 2048
    hop_size = max(1, round(sample_rate * 0.008))
    frame_count = 1 + max(0, (len(audio) - frame_size) // hop_size)
    window = np.hanning(frame_size)
    frequencies = np.fft.rfftfreq(frame_size, 1 / sample_rate)
    band = (frequencies >= 450) & (frequencies <= 6500)

    flux = np.zeros(frame_count, dtype=np.float64)
    rms = np.zeros(frame_count, dtype=np.float64)
    previous_spectrum = np.zeros(np.count_nonzero(band), dtype=np.float64)
    smoothed_spectrum = np.zeros_like(previous_spectrum)

    for frame_index in range(frame_count):
        start = frame_index * hop_size
        frame = audio[start : start + frame_size]
        rms[frame_index] = math.sqrt(float(np.mean(frame * frame)))
        magnitude = np.abs(np.fft.rfft(frame * window))[band]
        decibels = 20 * np.log10(np.maximum(magnitude, 1e-10))
        byte_spectrum = np.clip((decibels + 100) * (255 / 70), 0, 255)
        smoothed_spectrum = 0.08 * smoothed_spectrum + 0.92 * byte_spectrum
        increase = smoothed_spectrum - previous_spectrum
        flux[frame_index] = float(np.mean(np.maximum(increase, 0)))
        previous_spectrum = smoothed_spectrum.copy()

    normalized_rms = rms / max(float(np.max(rms)), 1e-12)
    flux_mean = 0.0
    flux_deviation = 0.0
    thresholds = np.zeros_like(flux)
    for index, value in enumerate(flux):
        previous_mean = flux_mean
        flux_mean = flux_mean * 0.92 + value * 0.08
        flux_deviation = (
            flux_deviation * 0.92 + abs(value - previous_mean) * 0.08
        )
        thresholds[index] = flux_mean + flux_deviation * (3.45 - 7 * 0.22) + 0.18

    candidates = []
    for index in range(2, frame_count):
        peak_flux = flux[index - 1]
        if (
            peak_flux > thresholds[index - 1]
            and peak_flux > flux[index - 2]
            and peak_flux >= flux[index]
            and normalized_rms[index - 1] > 0.01
        ):
            candidates.append(
                {
                    "time_ms": (index - 1) * hop_size * 1000 / sample_rate,
                    "strength": peak_flux
                    * math.sqrt(max(normalized_rms[index - 1], 1e-5)),
                    "flux": peak_flux,
                    "rms": normalized_rms[index - 1],
                }
            )

    def accept_candidates(mode):
        spacing = 90 if mode == "rhythm" else 42
        accepted = []
        previous_candidate = None
        previous_strength = 0.0
        for candidate in candidates:
            time_ms = candidate["time_ms"]
            if previous_candidate is not None and time_ms - previous_candidate < spacing:
                previous_candidate = time_ms
                continue
            previous_candidate = time_ms
            if accepted:
                gap = time_ms - accepted[-1]["time_ms"]
                repeat_ratio = 0.2 * (1 - 0.35 * min(1, gap / 700))
                if gap < 700 and candidate["strength"] < previous_strength * repeat_ratio:
                    continue
            accepted.append(candidate)
            previous_strength = candidate["strength"]
        return accepted

    result = {
        "metadata": metadata,
        "peak": peak,
        "candidate_count": len(candidates),
        "candidate_times_ms": [round(item["time_ms"], 1) for item in candidates],
        "modes": {},
    }
    for mode in ("pick", "rhythm"):
        accepted = accept_candidates(mode)
        times = [item["time_ms"] for item in accepted]
        intervals = np.diff(times).tolist()
        result["modes"][mode] = {
            "accepted_count": len(accepted),
            "times_ms": [round(value, 1) for value in times],
            "intervals_ms": [round(value, 1) for value in intervals],
            "mean_interval_ms": round(float(np.mean(intervals)), 1)
            if intervals
            else None,
            "span_interval_ms": round((times[-1] - times[0]) / (len(times) - 1), 1)
            if len(times) > 1
            else None,
            "tempo": {
                str(subdivision): estimate_tempo(intervals, subdivision)
                for subdivision in (1, 2, 3, 4)
            },
            "window_span_tempos": [
                {
                    "start_seconds": window_start,
                    "count": len(window_times),
                    "sixteenth_bpm": round(
                        60000
                        / (((window_times[-1] - window_times[0]) / (len(window_times) - 1)) * 4),
                        1,
                    ),
                }
                for window_start in range(0, 33, 4)
                if len(
                    window_times := [
                        value
                        for value in times
                        if window_start * 1000 <= value < (window_start + 8) * 1000
                    ]
                )
                > 1
            ],
        }

    onset_envelope = np.maximum(np.diff(np.log10(np.maximum(rms, 1e-7))), 0)
    onset_envelope -= np.mean(onset_envelope)
    autocorrelation = np.correlate(onset_envelope, onset_envelope, mode="full")
    autocorrelation = autocorrelation[len(autocorrelation) // 2 :]
    period_scores = []
    for period_ms in np.arange(80, 1001, 1):
        lag = round(period_ms * sample_rate / (hop_size * 1000))
        if lag < len(autocorrelation):
            period_scores.append((float(autocorrelation[lag]), float(period_ms)))
    result["envelope_periods_ms"] = [
        round(period, 1)
        for _score, period in sorted(period_scores, reverse=True)[:10]
    ]
    local_period_peaks = []
    minimum_lag = round(80 * sample_rate / (hop_size * 1000))
    maximum_lag = min(
        len(autocorrelation) - 1,
        round(1000 * sample_rate / (hop_size * 1000)),
    )
    for lag in range(minimum_lag + 1, maximum_lag):
        if (
            autocorrelation[lag] > autocorrelation[lag - 1]
            and autocorrelation[lag] >= autocorrelation[lag + 1]
        ):
            local_period_peaks.append(
                (
                    float(autocorrelation[lag]),
                    lag * hop_size * 1000 / sample_rate,
                )
            )
    maximum_peak_score = max((score for score, _period in local_period_peaks), default=1)
    result["envelope_local_period_peaks"] = [
        {
            "period_ms": round(period, 1),
            "relative_score": round(score / maximum_peak_score, 3),
            "sixteenth_bpm": round(60000 / (period * 4), 1),
        }
        for score, period in sorted(local_period_peaks, reverse=True)[:15]
    ]
    centered_flux = flux - np.mean(flux)
    flux_autocorrelation = np.correlate(centered_flux, centered_flux, mode="full")
    flux_autocorrelation = flux_autocorrelation[len(flux_autocorrelation) // 2 :]
    flux_period_peaks = []
    for lag in range(minimum_lag + 1, min(maximum_lag, len(flux_autocorrelation) - 1)):
        if (
            flux_autocorrelation[lag] > flux_autocorrelation[lag - 1]
            and flux_autocorrelation[lag] >= flux_autocorrelation[lag + 1]
        ):
            flux_period_peaks.append(
                (
                    float(flux_autocorrelation[lag]),
                    lag * hop_size * 1000 / sample_rate,
                )
            )
    maximum_flux_score = max((score for score, _period in flux_period_peaks), default=1)
    result["flux_local_period_peaks"] = [
        {
            "period_ms": round(period, 1),
            "relative_score": round(score / maximum_flux_score, 3),
            "sixteenth_bpm": round(60000 / (period * 4), 1),
        }
        for score, period in sorted(flux_period_peaks, reverse=True)[:15]
    ]
    result["flux_window_periods"] = []
    window_frames = round(8 * sample_rate / hop_size)
    step_frames = round(4 * sample_rate / hop_size)
    for start in range(0, max(1, len(flux) - window_frames + 1), step_frames):
        segment = flux[start : start + window_frames]
        if len(segment) < window_frames:
            continue
        centered_segment = segment - np.mean(segment)
        segment_correlation = np.correlate(
            centered_segment,
            centered_segment,
            mode="full",
        )[len(centered_segment) - 1 :]
        peaks = []
        for lag in range(minimum_lag + 1, min(maximum_lag, len(segment_correlation) - 1)):
            if (
                segment_correlation[lag] > segment_correlation[lag - 1]
                and segment_correlation[lag] >= segment_correlation[lag + 1]
            ):
                peaks.append((float(segment_correlation[lag]), lag))
        if peaks:
            strongest_score = max(score for score, _lag in peaks)
            strong_peaks = [
                (score, lag)
                for score, lag in peaks
                if score >= strongest_score * 0.75
            ]
            score, lag = min(strong_peaks, key=lambda item: item[1])
            period = lag * hop_size * 1000 / sample_rate
            result["flux_window_periods"].append(
                {
                    "start_seconds": round(start * hop_size / sample_rate, 1),
                    "period_ms": round(period, 1),
                    "sixteenth_bpm": round(60000 / (period * 4), 1),
                    "relative_to_strongest": round(score / strongest_score, 3),
                }
            )
    result["envelope_window_peaks"] = []
    smoothed_onset_envelope = np.convolve(
        onset_envelope,
        np.asarray([0.25, 0.5, 0.25]),
        mode="same",
    )
    for window_seconds in (6, 8, 12, 16, 20):
        window_frames = round(window_seconds * sample_rate / hop_size)
        step_frames = round(4 * sample_rate / hop_size)
        for start in range(0, max(1, len(onset_envelope) - window_frames + 1), step_frames):
            segment = smoothed_onset_envelope[start : start + window_frames]
            if len(segment) < window_frames:
                continue
            centered_segment = segment - np.mean(segment)
            segment_correlation = np.correlate(
                centered_segment,
                centered_segment,
                mode="full",
            )[len(centered_segment) - 1 :]
            for lag in range(1, len(segment_correlation)):
                left = centered_segment[:-lag]
                right = centered_segment[lag:]
                denominator = math.sqrt(
                    float(np.dot(left, left) * np.dot(right, right))
                )
                segment_correlation[lag] = (
                    segment_correlation[lag] / denominator
                    if denominator > 1e-12
                    else 0
                )
            peaks = []
            for lag in range(
                minimum_lag + 1,
                min(maximum_lag, len(segment_correlation) - 1),
            ):
                if (
                    segment_correlation[lag] > segment_correlation[lag - 1]
                    and segment_correlation[lag] >= segment_correlation[lag + 1]
                ):
                    peaks.append((float(segment_correlation[lag]), lag))
            if not peaks:
                continue
            strongest_score = max(score for score, _lag in peaks)
            ranked = sorted(peaks, reverse=True)[:8]
            valid_sixteenth_peaks = [
                (score, lag)
                for score, lag in peaks
                if 50 <= lag * hop_size * 1000 / sample_rate <= 500
            ]
            strongest_sixteenth = max(
                (score for score, _lag in valid_sixteenth_peaks),
                default=0,
            )
            result["envelope_window_peaks"].append(
                {
                    "window_seconds": window_seconds,
                    "start_seconds": round(start * hop_size / sample_rate, 1),
                    "sixteenth_selections": {
                        str(ratio): round(
                            60000
                            / (
                                min(
                                    lag
                                    for score, lag in valid_sixteenth_peaks
                                    if score
                                    >= max(0.06, strongest_sixteenth * ratio)
                                )
                                * hop_size
                                * 1000
                                / sample_rate
                                * 4
                            ),
                            1,
                        )
                        for ratio in (0.55, 0.6, 0.68)
                        if strongest_sixteenth >= 0.08
                        and any(
                            score >= max(0.06, strongest_sixteenth * ratio)
                            for score, _lag in valid_sixteenth_peaks
                        )
                    },
                    "peaks": [
                        {
                            "period_ms": round(lag * hop_size * 1000 / sample_rate, 1),
                            "score": round(score, 3),
                            "relative_score": round(score / strongest_score, 3),
                            "sixteenth_bpm": round(
                                60000
                                / (lag * hop_size * 1000 / sample_rate * 4),
                                1,
                            ),
                        }
                        for score, lag in ranked
                    ],
                }
            )
    if "--summary" in sys.argv:
        result = {
            "metadata": result["metadata"],
            "peak": result["peak"],
            "candidate_count": result["candidate_count"],
            "modes": {
                mode: {
                    key: value
                    for key, value in details.items()
                    if key
                    in {
                        "accepted_count",
                        "mean_interval_ms",
                        "span_interval_ms",
                        "tempo",
                        "window_span_tempos",
                    }
                }
                for mode, details in result["modes"].items()
            },
            "envelope_local_period_peaks": result[
                "envelope_local_period_peaks"
            ],
            "flux_local_period_peaks": result["flux_local_period_peaks"],
            "flux_window_periods": result["flux_window_periods"],
            "envelope_window_peaks": result["envelope_window_peaks"],
        }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
