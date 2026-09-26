import { useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";
import { FileButton } from "./CopyButton";
import { Icon } from "./Icon";

export function QRCard({ value, label, download = false }: { value: string; label: string; download?: boolean }) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setImage(""); setError("");
    import("qrcode").then((qr) => qr.toDataURL(value, { width: 260, margin: 4, errorCorrectionLevel: "M" }))
      .then((result) => { if (!cancelled) setImage(result); })
      .catch(() => { if (!cancelled) setError("No se pudo generar el QR."); });
    return () => { cancelled = true; };
  }, [value]);
  return <figure className="authQRCard">
    {image ? <img src={image} alt={label} width={260} height={260} /> : <p role="status">{error || "Generando QR…"}</p>}
    <figcaption>{label}</figcaption>
    {download && image && <a className="secondaryButton" href={image} download="vigilia-gafete.png">Descargar gafete QR</a>}
  </figure>;
}

export function QRScanner({ onRead, cameraLabel = "Escanear con la cámara" }: { onRead: (value: string) => void; cameraLabel?: string }) {
  const [scanning, setScanning] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const callback = useRef(onRead);
  callback.current = onRead;
  useEffect(() => {
    if (!scanning || !video.current) return;
    let cancelled = false;
    let read = false;
    import("@zxing/browser").then(async ({ BrowserQRCodeReader }) => {
      if (cancelled) return;
      const reader = new BrowserQRCodeReader();
      const scanner = await reader.decodeFromConstraints({ video: { facingMode: "environment" }, audio: false }, video.current!, (result, _error, activeControls) => {
        if (result && !cancelled && !read) {
          read = true; activeControls.stop(); setScanning(false); callback.current(result.getText());
        }
      });
      if (cancelled || read) scanner.stop(); else controls.current = scanner;
    }).catch(() => { if (!cancelled) { setError("No se pudo abrir la cámara. Permite su uso o carga una imagen del QR."); setScanning(false); } });
    return () => { cancelled = true; controls.current?.stop(); controls.current = null; };
  }, [scanning]);
  async function scanImage(file?: File) {
    if (!file) return;
    setScanning(false); setError(""); setReading(true);
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      callback.current(result.getText());
    } catch { setError("No encontramos un QR legible en esa imagen."); }
    finally { URL.revokeObjectURL(url); setReading(false); }
  }
  return <div className="authScanner">
    <div className="authScannerActions">
      <button className="secondaryButton" type="button" onClick={() => { setError(""); setScanning(!scanning); }}><Icon name="camera" size={16} />{scanning ? "Cerrar cámara" : cameraLabel}</button>
      <FileButton label={reading ? "Leyendo QR…" : "Cargar imagen del QR"} accept="image/*" disabled={reading} onFile={(file) => void scanImage(file)} />
    </div>
    {scanning && <video ref={video} autoPlay muted playsInline aria-label="Cámara para escanear el gafete" />}
    {error && <p className="adminNotice error" role="alert">{error}</p>}
  </div>;
}
