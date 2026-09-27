import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Menus, suggestion lists and the date picker are drawn by Vigilia instead of the operating system,
 * so they keep the app's glass look on Windows, Android and Linux. Apple's native pickers already
 * fit (and on iPhone they are the expected wheel / sheet), so macOS and iOS keep them.
 */
export const USES_NATIVE_PICKERS = (() => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  // iPadOS reports itself as "Macintosh", which is still Apple.
  return /mac|iphone|ipad|ipod/i.test(platform) || /iPhone|iPad|iPod|Macintosh/.test(nav.userAgent);
})();

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

type Placement = { style: CSSProperties; side: "below" | "above" };

/** Keeps a floating layer glued to its anchor, flipping above it when there is no room below. */
function useAnchoredLayer(anchorRef: RefObject<HTMLElement | null>, open: boolean, preferredHeight: number, minWidth = 0, maxWidth = Number.POSITIVE_INFINITY) {
  const [placement, setPlacement] = useState<Placement | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const available = viewportWidth - VIEWPORT_MARGIN * 2;
    const floor = Math.min(Math.max(rect.width, minWidth), maxWidth, available);
    // Menus grow with their longest option; the calendar has a fixed width.
    const width = Number.isFinite(maxWidth) ? floor : undefined;
    const alignRight = rect.left + Math.max(floor, width ?? 260) > viewportWidth - VIEWPORT_MARGIN;
    const horizontal: CSSProperties = alignRight
      ? { right: Math.max(VIEWPORT_MARGIN, viewportWidth - rect.right) }
      : { left: Math.max(VIEWPORT_MARGIN, rect.left) };
    const below = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const side = below >= Math.min(preferredHeight, 220) || below >= above ? "below" : "above";
    const maxHeight = Math.max(120, Math.min(preferredHeight, side === "below" ? below : above));
    setPlacement({
      side,
      style: side === "below"
        ? { ...horizontal, top: rect.bottom + MENU_GAP, width, minWidth: floor, maxWidth: available, maxHeight }
        : { ...horizontal, bottom: viewportHeight - rect.top + MENU_GAP, width, minWidth: floor, maxWidth: available, maxHeight },
    });
  }, [anchorRef, maxWidth, minWidth, preferredHeight]);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return placement;
}

/** Closes a floating layer when the pointer goes down outside both the anchor and the layer. */
function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const handle = (event: PointerEvent) => {
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      dismissRef.current();
    };
    document.addEventListener("pointerdown", handle, true);
    return () => document.removeEventListener("pointerdown", handle, true);
    // The refs are stable objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function Chevron() {
  return <svg className="appPickerChevron" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>;
}

function Check() {
  return <svg className="appOptionCheck" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>;
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

/** Drop-in replacement for a native `<select>` (select-only combobox, WAI-ARIA pattern). */
export function Select({ value, onChange, options, disabled, id, className = "", placeholder = "Selecciona una opción", ...aria }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const generatedId = useId();
  const triggerId = id ?? `select-${generatedId}`;
  const listId = `${triggerId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [active, setActive] = useState(Math.max(0, selectedIndex));
  const typeahead = useRef({ text: "", at: 0 });
  const placement = useAnchoredLayer(triggerRef, open, 320, 180);
  useDismiss(open, [triggerRef, menuRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, placement]);

  if (USES_NATIVE_PICKERS) {
    return (
      <select id={id} className={className} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} {...aria}>
        {selectedIndex < 0 && <option value={value} disabled>{placeholder}</option>}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    );
  }

  const enabledStep = (from: number, step: 1 | -1) => {
    for (let index = from + step; index >= 0 && index < options.length; index += step) if (!options[index].disabled) return index;
    return from;
  };
  const edge = (fromEnd: boolean) => {
    const indices = options.map((_, index) => index).filter((index) => !options[index].disabled);
    return (fromEnd ? indices[indices.length - 1] : indices[0]) ?? 0;
  };

  function openMenu(at = selectedIndex) {
    setActive(at >= 0 && !options[at]?.disabled ? at : edge(false));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  }

  function findByText(key: string) {
    const now = Date.now();
    typeahead.current = { text: now - typeahead.current.at < 600 ? typeahead.current.text + key : key, at: now };
    const wanted = fold(typeahead.current.text);
    const start = open ? active : Math.max(0, selectedIndex);
    const order = options.map((_, index) => (start + (wanted.length === 1 ? 1 : 0) + index) % options.length);
    return order.find((index) => !options[index].disabled && fold(options[index].label).startsWith(wanted)) ?? -1;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        event.preventDefault();
        openMenu();
      } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const found = findByText(key);
        if (found >= 0) choose(found);
      }
      return;
    }
    const moves: Record<string, () => number> = {
      ArrowDown: () => enabledStep(active, 1),
      ArrowUp: () => enabledStep(active, -1),
      Home: () => edge(false),
      End: () => edge(true),
      PageDown: () => Math.min(options.length - 1, active + 8),
      PageUp: () => Math.max(0, active - 8),
    };
    if (moves[key]) {
      event.preventDefault();
      setActive(moves[key]());
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      choose(active);
    } else if (key === "Escape") {
      // Only the menu closes; a sheet around it stays open.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = findByText(key);
      if (found >= 0) setActive(found);
    }
  }

  const selected = options[selectedIndex];
  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`appSelectTrigger${open ? " open" : ""}${selected ? "" : " placeholder"} ${className}`.trim()}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        {...aria}
      >
        <span className="appSelectValue">{selected?.label ?? placeholder}</span>
        <Chevron />
      </button>
      {open && placement && createPortal(
        <div ref={menuRef} className={`appPickerLayer appSelectMenu ${placement.side}`} style={placement.style} onMouseDown={(event) => event.preventDefault()}>
          <ul role="listbox" id={listId} aria-labelledby={triggerId} tabIndex={-1}>
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={`${index === active ? "active" : ""}${index === selectedIndex ? " selected" : ""}`.trim() || undefined}
                // Keep the focus on the trigger so the screen reader follows aria-activedescendant.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => { if (!option.disabled && active !== index) setActive(index); }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {index === selectedIndex && <Check />}
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Text input with suggestions drawn by the app (replaces `<input list>` + `<datalist>`). */
export function SuggestInput({ suggestions, value, onChange, inputRef, ...input }: {
  suggestions: string[];
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list">) {
  const generatedId = useId();
  const listId = `suggest-${generatedId}`;
  const ownRef = useRef<HTMLInputElement>(null);
  const anchorRef = inputRef ?? ownRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = useMemo(() => {
    const wanted = fold(value.trim());
    const unique = [...new Set(suggestions.filter(Boolean))];
    return (wanted ? unique.filter((item) => fold(item).includes(wanted) && fold(item) !== wanted) : unique).slice(0, 8);
  }, [suggestions, value]);
  const visible = open && matches.length > 0;
  const placement = useAnchoredLayer(anchorRef, visible, 280);
  useDismiss(visible, [anchorRef as RefObject<HTMLElement | null>, menuRef], () => setOpen(false));
  useEffect(() => setActive(-1), [value]);

  if (USES_NATIVE_PICKERS) {
    return <>
      <input ref={anchorRef} {...input} list={listId} value={value} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>{suggestions.map((name) => <option key={name} value={name} />)}</datalist>
    </>;
  }

  function choose(index: number) {
    const item = matches[index];
    if (item === undefined) return;
    onChange(item);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    input.onKeyDown?.(event);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!matches.length) return;
      event.preventDefault();
      if (!visible) { setOpen(true); setActive(event.key === "ArrowDown" ? 0 : matches.length - 1); return; }
      setActive((current) => event.key === "ArrowDown" ? (current + 1) % matches.length : (current <= 0 ? matches.length - 1 : current - 1));
    } else if (event.key === "Enter" && visible && active >= 0) {
      // Pick the suggestion instead of submitting the form.
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" && visible) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <>
      <input
        ref={anchorRef}
        {...input}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onFocus={(event) => { input.onFocus?.(event); setOpen(true); }}
        onClick={(event) => { input.onClick?.(event); setOpen(true); }}
        onBlur={(event) => { input.onBlur?.(event); setOpen(false); }}
        onKeyDown={onKeyDown}
      />
      {visible && placement && createPortal(
        <div ref={menuRef} className={`appPickerLayer appSelectMenu ${placement.side}`} style={placement.style} onMouseDown={(event) => event.preventDefault()}>
          <p className="appSuggestHint" aria-hidden="true">Usados recientemente</p>
          <ul role="listbox" id={listId} aria-label="Sugerencias" tabIndex={-1}>
            {matches.map((item, index) => (
              <li key={item} id={`${listId}-${index}`} role="option" aria-selected={index === active} className={index === active ? "active" : undefined}
                onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Date and time ────────────────────────────────────────────────────────
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];
const WEEKDAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const pad = (value: number) => String(value).padStart(2, "0");
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);

/** Parses the `YYYY-MM-DDTHH:mm` value of a datetime-local field as local time. */
function parseLocal(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) : null;
}
const toLocalValue = (date: Date) => `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

function formatDisplay(date: Date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Same contract as `<input type="datetime-local">` (value `YYYY-MM-DDTHH:mm`, optional `max`). */
export function DateTimeField({ value, onChange, max, id, disabled, required, placeholder = "Elige fecha y hora", ...aria }: {
  value: string;
  onChange: (value: string) => void;
  max?: string;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const generatedId = useId();
  const triggerId = id ?? `date-${generatedId}`;
  const dialogId = `${triggerId}-picker`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = parseLocal(value);
  const limit = max ? parseLocal(max) : null;
  const [focusDay, setFocusDay] = useState<Date>(() => current ?? new Date());
  const placement = useAnchoredLayer(triggerRef, open, 440, 312, 312);
  useDismiss(open, [triggerRef, layerRef], () => setOpen(false));

  useEffect(() => {
    if (!open || !placement) return;
    layerRef.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(focusDay)}"]`)?.focus({ preventScroll: true });
  }, [focusDay, open, placement]);

  if (USES_NATIVE_PICKERS) {
    return <input id={id} type="datetime-local" required={required} disabled={disabled} max={max} value={value} onChange={(event) => onChange(event.target.value)} {...aria} />;
  }

  const isAfterLimit = (day: Date) => Boolean(limit && dayKey(day) > dayKey(limit));

  function emit(next: Date) {
    const clamped = limit && next > limit ? limit : next;
    onChange(toLocalValue(clamped));
  }

  function openPicker() {
    setFocusDay(current ?? new Date());
    setOpen(true);
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function pickDay(day: Date) {
    if (isAfterLimit(day)) return;
    const base = current ?? new Date();
    emit(new Date(day.getFullYear(), day.getMonth(), day.getDate(), base.getHours(), base.getMinutes()));
    setFocusDay(day);
  }

  function setTime(hours: number, minutes: number) {
    const base = current ?? new Date();
    emit(new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes));
  }

  function shiftFocus(days: number, months = 0) {
    const next = new Date(focusDay.getFullYear(), focusDay.getMonth() + months, focusDay.getDate() + days);
    if (months) next.setDate(Math.min(focusDay.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    setFocusDay(next);
  }

  function onGridKey(event: KeyboardEvent<HTMLDivElement>) {
    const weekday = (focusDay.getDay() + 6) % 7;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => shiftFocus(-1),
      ArrowRight: () => shiftFocus(1),
      ArrowUp: () => shiftFocus(-7),
      ArrowDown: () => shiftFocus(7),
      Home: () => shiftFocus(-weekday),
      End: () => shiftFocus(6 - weekday),
      PageUp: () => shiftFocus(0, event.shiftKey ? -12 : -1),
      PageDown: () => shiftFocus(0, event.shiftKey ? 12 : 1),
    };
    if (moves[event.key]) { event.preventDefault(); moves[event.key](); }
  }

  function onLayerKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  const monthStart = new Date(focusDay.getFullYear(), focusDay.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  const weeks = Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7))
    .filter((week, index) => index < 5 || week.some((day) => day.getMonth() === monthStart.getMonth()));
  const today = new Date();
  const nextMonthBlocked = Boolean(limit && new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1) > limit);
  const hours = current?.getHours() ?? today.getHours();
  const minutes = current?.getMinutes() ?? today.getMinutes();

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`appSelectTrigger appDateTrigger${open ? " open" : ""}${current ? "" : " placeholder"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); openPicker(); } }}
        {...aria}
      >
        <span className="appSelectValue">{current ? formatDisplay(current) : placeholder}</span>
        <svg className="appPickerChevron" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
      </button>
      {open && placement && createPortal(
        <div ref={layerRef} id={dialogId} className={`appPickerLayer appDatePicker ${placement.side}`} style={placement.style} role="dialog" aria-modal="false" aria-label="Elegir fecha y hora" onKeyDown={onLayerKey}
          onBlur={(event) => { const next = event.relatedTarget as Node | null; if (next && !layerRef.current?.contains(next) && next !== triggerRef.current) setOpen(false); }}>
          <div className="appDateHeader">
            <button type="button" className="appDateNav" aria-label="Mes anterior" onClick={() => shiftFocus(0, -1)}>‹</button>
            <strong aria-live="polite">{MONTHS[monthStart.getMonth()]} {monthStart.getFullYear()}</strong>
            <button type="button" className="appDateNav" aria-label="Mes siguiente" disabled={nextMonthBlocked} onClick={() => shiftFocus(0, 1)}>›</button>
          </div>
          <div className="appDateGrid" role="grid" aria-label={`${MONTHS[monthStart.getMonth()]} ${monthStart.getFullYear()}`} onKeyDown={onGridKey}>
            <div role="row" className="appDateRow">{WEEKDAYS.map((day, index) => <span key={day} role="columnheader" aria-label={WEEKDAY_NAMES[index]} className="appDateWeekday">{day}</span>)}</div>
            {weeks.map((week) => (
              <div role="row" className="appDateRow" key={dayKey(week[0])}>
                {week.map((day) => {
                  const selected = current ? sameDay(day, current) : false;
                  const blocked = isAfterLimit(day);
                  return (
                    <span role="gridcell" key={dayKey(day)} aria-selected={selected}>
                      <button
                        type="button"
                        data-day={dayKey(day)}
                        tabIndex={sameDay(day, focusDay) ? 0 : -1}
                        disabled={blocked}
                        aria-label={`${WEEKDAY_NAMES[(day.getDay() + 6) % 7]} ${day.getDate()} de ${MONTHS[day.getMonth()]} de ${day.getFullYear()}`}
                        aria-current={sameDay(day, today) ? "date" : undefined}
                        className={`appDateDay${day.getMonth() !== monthStart.getMonth() ? " outside" : ""}${selected ? " selected" : ""}${sameDay(day, today) ? " today" : ""}`}
                        onClick={() => pickDay(day)}
                      >{day.getDate()}</button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="appDateTime">
            <span>Hora</span>
            <TimeUnit label="Horas" value={hours} max={23} onChange={(next) => setTime(next, minutes)} />
            <b aria-hidden="true">:</b>
            <TimeUnit label="Minutos" value={minutes} max={59} onChange={(next) => setTime(hours, next)} />
          </div>
          <div className="appDateActions">
            <button type="button" className="adminTextButton" onClick={() => { const now = new Date(); emit(now); setFocusDay(now); }}>Ahora</button>
            <button type="button" className="secondaryButton" onClick={() => close()}>Listo</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Two-digit time part: type it, or use the arrow keys / buttons (wraps around). */
function TimeUnit({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(pad(value));
  useEffect(() => setText(pad(value)), [value]);
  const wrap = (next: number) => ((next % (max + 1)) + max + 1) % (max + 1);
  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) { setText(pad(value)); return; }
    onChange(Math.min(max, Math.max(0, parsed)));
  };
  return (
    <span className="appTimeUnit">
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => onChange(wrap(value + 1))}>▴</button>
      <input
        aria-label={label}
        inputMode="numeric"
        maxLength={2}
        value={text}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
          setText(digits);
          if (digits.length === 2) commit(digits);
        }}
        onBlur={() => commit(text)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            onChange(wrap(value + (event.key === "ArrowUp" ? 1 : -1)));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit(text);
          }
        }}
      />
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => onChange(wrap(value - 1))}>▾</button>
    </span>
  );
}
