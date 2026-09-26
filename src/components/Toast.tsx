import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ToastTone = "success" | "error";
interface ToastItem { id: number; tone: ToastTone; message: string }
interface ToastApi { success: (message: string) => void; error: (message: string) => void }

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = ++nextId.current;
    setItems((current) => [...current.slice(-2), { id, tone, message }]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000));
  }, [dismiss]);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const api = useMemo<ToastApi>(() => ({ success: (message) => push("success", message), error: (message) => push("error", message) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toastStack" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`adminNotice toast${item.tone === "error" ? " error" : ""}`} role={item.tone === "error" ? "alert" : undefined}>
            <span>{item.message}</span>
            <button type="button" className="toastClose" aria-label="Cerrar aviso" onClick={() => dismiss(item.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast requiere ToastProvider.");
  return api;
}
