import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Modal focus contract shared by sheets and dialogs: lock scroll, trap Tab, close on Escape, restore focus. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (initialFocusRef.current ?? dialogRef.current)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.requestAnimationFrame(() => {
        const target = returnFocusRef?.current?.isConnected ? returnFocusRef.current : opener;
        if (target?.isConnected) target.focus();
      });
    };
  }, [dialogRef, initialFocusRef, returnFocusRef]);
}

/** Side sheet with the activity-detail look: glass panel sliding from the right (bottom on phones). */
export function Sheet({ eyebrow, title, subtitle, headerExtra, onClose, children, returnFocusRef, closeLabel = "Cerrar" }: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  headerExtra?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocus(dialogRef, closeRef, onClose, returnFocusRef);

  return (
    <div className="activitySheetBackdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="activitySheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
        <header className="activitySheetHeader">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
            {headerExtra}
          </div>
          <button ref={closeRef} className="activitySheetClose" type="button" aria-label={closeLabel} onClick={onClose}>×</button>
        </header>
        <div className="activitySheetBody">{children}</div>
      </aside>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "default";
}

/** Centered confirmation for destructive or irreversible actions. */
export function ConfirmDialog({ title, body, confirmLabel, tone = "danger", onConfirm, onCancel }: ConfirmOptions & {
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [working, setWorking] = useState(false);
  useDialogFocus(dialogRef, cancelRef, () => { if (!working) onCancel(); });

  async function confirm() {
    setWorking(true);
    try {
      await onConfirm();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="activitySheetBackdrop dialogBackdrop" onClick={(event) => { if (event.target === event.currentTarget && !working) onCancel(); }}>
      <section className={`confirmDialog glassPanel${tone === "danger" ? " danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} ref={dialogRef} tabIndex={-1}>
        <span className="eyebrow">{tone === "danger" ? "CONFIRMA LA ACCIÓN" : "CONFIRMACIÓN"}</span>
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="confirmBody">{body}</div>
        <div className="adminFormActions confirmActions">
          <button ref={cancelRef} className="secondaryButton" type="button" onClick={onCancel} disabled={working}>Cancelar</button>
          <button className={`primaryButton${tone === "danger" ? " dangerButton" : ""}`} type="button" onClick={() => void confirm()} disabled={working}>{working ? "Aplicando…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

/** Keeps one pending confirmation and resolves it with the caller's action. */
export function useConfirm() {
  const [pending, setPending] = useState<(ConfirmOptions & { action: () => Promise<void> | void }) | null>(null);
  const dialog = pending ? (
    <ConfirmDialog
      {...pending}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        try { await pending.action(); } finally { setPending(null); }
      }}
    />
  ) : null;
  return { confirm: (options: ConfirmOptions, action: () => Promise<void> | void) => setPending({ ...options, action }), dialog };
}
