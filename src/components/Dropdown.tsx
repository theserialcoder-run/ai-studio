"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** `group` shows a heading above the first option of each run of the same group (like <optgroup>). */
export interface DropdownOption { value: string; label: string; hint?: string; group?: string; disabled?: boolean }

/**
 * The app's styled replacement for <select>: the native option list is drawn by
 * the OS (e.g. a bright blue highlight on Linux) and can't be themed.
 * Keyboard: Enter/Space/↓ opens, ↑/↓/Home/End move, Enter selects, Esc closes.
 * Works inside a <label> (the label names it; clicks in the list don't re-open it).
 */
export function Dropdown({ value, options, onChange, ariaLabel, disabled, placeholder = "Choose…", leading, compact, className = "" }: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  leading?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find(o => o.value === value);
  const enabled = (i: number) => !!options[i] && !options[i].disabled;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function show() {
    if (disabled || !options.length) return;
    const sel = options.findIndex(o => o.value === value);
    setActive(sel >= 0 ? sel : Math.max(0, options.findIndex(o => !o.disabled)));
    setOpen(true);
  }

  function pick(i: number) {
    if (!enabled(i)) return;
    setOpen(false);
    if (options[i].value !== value) onChange(options[i].value);
  }

  /** Next enabled index from `from` in direction `dir`, or `from` if none. */
  function step(from: number, dir: 1 | -1) {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => step(a, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => step(a, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActive(step(options.length, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div ref={root} className={`dropdown${open ? " open" : ""}${compact ? " compact" : ""} ${className}`}>
      <button type="button" role="combobox" className="dropdown-button" disabled={disabled} aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        {leading}
        <span className={`dropdown-value${current ? "" : " placeholder"}`}>{current?.label ?? placeholder}</span>
        <span className="dropdown-chevron" aria-hidden />
      </button>
      {open && (
        // preventDefault: inside a <label>, a click would otherwise "activate" the label and re-open the list.
        <ul className="dropdown-list" role="listbox" id={listId} aria-label={ariaLabel} onClick={e => e.preventDefault()}>
          {options.map((o, i) => {
            const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
            return [
              heading && <li key={`g-${i}`} role="presentation" className="dropdown-group">{heading}</li>,
              <li key={`${o.value}-${i}`} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
                className={`dropdown-option${i === active ? " active" : ""}${o.value === value ? " selected" : ""}${o.disabled ? " disabled" : ""}${o.group ? " grouped" : ""}`}
                onMouseEnter={() => { if (!o.disabled) setActive(i); }} onMouseDown={e => e.preventDefault()} onClick={() => pick(i)}>
                <span className="dropdown-option-text">
                  <span>{o.label}</span>
                  {o.hint && <small>{o.hint}</small>}
                </span>
                {o.value === value && <span className="dropdown-check" aria-hidden>✓</span>}
              </li>,
            ];
          })}
        </ul>
      )}
    </div>
  );
}
