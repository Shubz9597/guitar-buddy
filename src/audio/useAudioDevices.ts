import { useCallback, useEffect, useState } from "react";

export interface AudioDevice {
  id: string;
  label: string;
}

function list(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string): AudioDevice[] {
  return devices
    .filter((device) => device.kind === kind && device.deviceId !== "default" && device.deviceId !== "communications")
    .map((device, index) => ({ id: device.deviceId, label: device.label || `${fallback} ${index + 1}` }));
}

export function useAudioDevices() {
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  // Browsers hide device names until audio input access has been granted.
  const [labelled, setLabelled] = useState(true);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(list(devices, "audioinput", "Input"));
    setOutputs(list(devices, "audiooutput", "Output"));
    setLabelled(devices.some((device) => device.kind === "audioinput" && device.label !== ""));
  }, []);

  const requestAccess = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    const onChange = () => void refresh();
    onChange();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refresh]);

  return { inputs, outputs, labelled, refresh, requestAccess };
}
