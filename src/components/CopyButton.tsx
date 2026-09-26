import { useEffect, useState, type ChangeEvent } from "react";
import { Icon } from "./Icon";

/** Copies a value without exposing it anywhere else; falls back to selection when the clipboard is blocked. */
export function CopyButton({ value, label = "Copiar", compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const text = state === "copied" ? "Copiado" : state === "failed" ? "Selecciónalo y cópialo" : label;
  return (
    <button type="button" className={`copyButton${compact ? " compact" : ""}${state === "copied" ? " done" : ""}`} onClick={(event) => { event.stopPropagation(); void copy(); }} aria-label={compact ? `${label}: ${value}` : undefined} title={compact ? text : undefined}>
      <Icon name={state === "copied" ? "check" : "copy"} size={13} />
      {!compact && <span>{text}</span>}
      <span className="srOnly" aria-live="polite">{compact && state !== "idle" ? text : ""}</span>
    </button>
  );
}

/** Styled file picker: keeps the native input for accessibility but hides its untranslated chrome. */
export function FileButton({ label, accept, disabled = false, onFile }: { label: string; accept?: string; disabled?: boolean; onFile: (file: File | undefined) => void }) {
  return (
    <label className={`secondaryButton fileButton${disabled ? " disabled" : ""}`}>
      <Icon name="upload" size={15} />
      <span>{label}</span>
      <input type="file" accept={accept} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
    </label>
  );
}
