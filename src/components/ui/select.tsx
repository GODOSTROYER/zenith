"use client";
import {
  forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type SelectHTMLAttributes, type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "@/lib/format";
import { useFieldProps } from "./field";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  /** Shown as a disabled first entry when the value is empty. */
  placeholder?: string;
}

const CONTROL = "ui-select flex h-9 w-full min-w-0 items-center gap-2 rounded-ctl border bg-bg1 px-3 text-left text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)] disabled:cursor-not-allowed disabled:opacity-55";

/**
 * Themed select-only combobox. Focus stays on the trigger while the portaled
 * listbox uses aria-activedescendant. A hidden native select preserves form
 * submission, validation, resets, refs, and actual select change events.
 */
const DropdownSelect = forwardRef<HTMLSelectElement, SelectProps>(function DropdownSelect(
  { options, placeholder, className, id, value, defaultValue, disabled, autoFocus, tabIndex, style, ...rest },
  ref,
) {
  const f = useFieldProps(id, rest);
  const generatedId = useId();
  const controlId = f.id ?? `${generatedId}-select`;
  const listId = `${controlId}-options`;
  const errorId = `${controlId}-validation`;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [validation, setValidation] = useState("");
  const search = useRef({ text: "", time: 0 });
  const choices = placeholder ? [{ value: "", label: placeholder, disabled: true }, ...options] : options;
  const firstEnabled = choices.findIndex((option) => !option.disabled);
  const [uncontrolledValue, setUncontrolledValue] = useState(() =>
    defaultValue === undefined ? options.find((option) => !option.disabled)?.value ?? "" : String(defaultValue),
  );
  const requestedValue = value === undefined ? uncontrolledValue : String(value);
  // React's native single-select falls back to the first enabled option when
  // its supplied value has no matching option (e.g. after async options load).
  const selectedIndex = choices.findIndex((option) => option.value === requestedValue);
  const selected = choices[selectedIndex < 0 ? firstEnabled : selectedIndex];
  const active = choices[activeIndex] && !choices[activeIndex].disabled ? activeIndex : -1;
  const expanded = open && !disabled && !rest.hidden;
  const describedBy = [f["aria-describedby"], validation ? errorId : undefined].filter(Boolean).join(" ") || undefined;

  useImperativeHandle(ref, () => native.current!, []);

  useLayoutEffect(() => {
    // Native option removal can change an uncontrolled value. Adopt that
    // change so restoring an old option cannot resurrect a stale label.
    if (value === undefined && native.current) setUncontrolledValue(native.current.value);
  }, [options, placeholder, value]);

  useEffect(() => {
    if (disabled || rest.hidden) setOpen(false);
  }, [disabled, rest.hidden]);

  // Keep the original defaultValue so form.reset() restores the initial
  // choice. Controlled selects keep their owner's value instead.
  useEffect(() => {
    const select = native.current;
    const form = select?.form;
    if (!select || !form) return;
    const reset = (event: Event) => {
      queueMicrotask(() => {
        if (event.defaultPrevented || !select.isConnected) return;
        if (value === undefined) setUncontrolledValue(select.value);
        else select.value = selected?.value ?? "";
        setValidation("");
        setOpen(false);
      });
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [rest.form, value, selected?.value]);

  useLayoutEffect(() => {
    const list = panel.current;
    const button = trigger.current;
    if (!expanded || !list || !button) return;
    const position = () => {
      const bounds = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const margin = 12;
      const availableWidth = Math.max(0, width - margin * 2);
      const listWidth = Math.min(Math.max(bounds.width, 176), availableWidth);
      list.style.width = `${listWidth}px`;
      list.style.left = `${Math.max(left + margin, Math.min(bounds.left, left + width - margin - listWidth))}px`;
      const below = top + height - bounds.bottom - margin - 4;
      const above = bounds.top - top - margin - 4;
      const placeAbove = Math.min(list.scrollHeight, 288) > below && above > below;
      list.style.maxHeight = `${Math.max(0, Math.min(288, placeAbove ? above : below))}px`;
      const listHeight = list.getBoundingClientRect().height;
      list.style.top = `${Math.max(top + margin, placeAbove ? bounds.top - listHeight - 4 : bounds.bottom + 4)}px`;
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(button);
    observer?.observe(list);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !native.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("mousedown", outside);
    document.addEventListener("click", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("click", outside);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (expanded && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, active, listId]);

  /** Forward interaction handlers with their existing HTMLSelectElement target. */
  const relay = (event: SyntheticEvent<HTMLButtonElement>) => {
    const select = native.current;
    if (!select) return true;
    event.stopPropagation();
    const EventType = event.nativeEvent.constructor as typeof Event;
    const accepted = select.dispatchEvent(new EventType(event.nativeEvent.type, event.nativeEvent));
    if (!accepted) event.preventDefault();
    return accepted;
  };

  const show = (index = selectedIndex) => {
    if (native.current?.matches(":disabled")) return;
    setActiveIndex(index >= 0 && !choices[index]?.disabled ? index : firstEnabled);
    search.current = { text: "", time: 0 };
    setOpen(true);
  };

  const commit = (index: number) => {
    const select = native.current;
    const option = choices[index];
    if (!select || select.matches(":disabled") || !option || option.disabled) return;
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setValidation("");
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!relay(event) || disabled) return;
    const enabled = choices.flatMap((option, index) => option.disabled ? [] : [index]);
    const at = enabled.indexOf(active);
    const edge = (last: boolean) => enabled[last ? enabled.length - 1 : 0] ?? -1;
    if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Tab") {
      if (expanded) commit(active);
      return; // Normal form tab order, never a modal focus trap.
    }
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      if (expanded) commit(active);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home" || event.key === "End") {
        if (!expanded) show(edge(event.key === "End"));
        else setActiveIndex(edge(event.key === "End"));
      } else if (!expanded) show();
      else {
        const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
        const distance = event.key.startsWith("Page") ? 10 : 1;
        setActiveIndex(enabled[Math.max(0, Math.min(enabled.length - 1, at + direction * distance))] ?? -1);
      }
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (expanded) commit(active);
      else show();
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const now = Date.now();
    const text = (now - search.current.time > 700 ? "" : search.current.text) + event.key.toLocaleLowerCase();
    const repeated = [...text].every((letter) => letter === text[0]);
    const needle = repeated ? text[0] : text;
    const from = expanded ? active : selectedIndex;
    const start = repeated ? from + 1 : Math.max(0, from);
    const order = [...choices.keys()].map((_, index) => (start + index) % choices.length);
    const match = order.find((index) => !choices[index].disabled && choices[index].label.toLocaleLowerCase().startsWith(needle));
    if (!expanded) show();
    search.current = { text, time: now };
    if (match !== undefined) setActiveIndex(match);
  };

  const visualProps = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith("aria-") || key.startsWith("data-")));
  return (
    <div className={cx("relative min-w-0", className)} hidden={rest.hidden}>
      <button
        {...visualProps}
        ref={trigger}
        id={controlId}
        data-select-trigger=""
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={describedBy}
        aria-labelledby={f["aria-labelledby"]}
        aria-invalid={f["aria-invalid"] || Boolean(validation) || undefined}
        aria-required={f["aria-required"] ?? (rest.required || undefined)}
        disabled={disabled}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        title={rest.title}
        dir={rest.dir}
        lang={rest.lang}
        accessKey={rest.accessKey}
        style={style}
        className={cx(CONTROL, f.invalid || validation ? "border-err" : "border-control-line hover:border-line-strong focus:border-signal")}
        onClick={(event) => { if (relay(event)) { trigger.current?.focus(); if (expanded) setOpen(false); else show(); } }}
        onKeyDown={onKeyDown}
        onKeyUp={relay}
        onMouseDown={relay}
        onMouseUp={relay}
        onPointerDown={relay}
        onPointerUp={relay}
        onFocus={relay}
        onBlur={(event) => { relay(event); setOpen(false); }}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder ?? "\u00a0"}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      </button>
      <select
        {...rest}
        ref={native}
        id={`${controlId}-native`}
        data-select-native=""
        role="combobox"
        aria-hidden="true"
        aria-expanded={expanded}
        aria-describedby={f["aria-describedby"]}
        aria-labelledby={f["aria-labelledby"]}
        aria-invalid={f["aria-invalid"]}
        aria-required={f["aria-required"]}
        tabIndex={-1}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        className="sr-only"
        onChange={(event) => {
          if (value === undefined) setUncontrolledValue(event.currentTarget.value);
          setValidation("");
          rest.onChange?.(event);
        }}
        onKeyDown={(event) => {
          rest.onKeyDown?.(event);
          if (expanded && event.key === "Escape") event.stopPropagation();
        }}
        onFocus={(event) => {
          if (document.activeElement === native.current) trigger.current?.focus();
          else rest.onFocus?.(event);
        }}
        onBlur={(event) => { if (event.relatedTarget !== trigger.current) rest.onBlur?.(event); }}
        onInvalid={(event) => {
          rest.onInvalid?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          setValidation(event.currentTarget.validationMessage);
          const firstInvalid = event.currentTarget.form?.querySelector("input:invalid, select:invalid, textarea:invalid");
          if (!firstInvalid || firstInvalid === event.currentTarget) trigger.current?.focus();
        }}
      >
        {choices.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {validation && <p id={errorId} role="alert" className="mt-1.5 text-[12px] text-err">{validation}</p>}
      {expanded && createPortal(
        <div
          ref={panel}
          id={listId}
          role="listbox"
          aria-label={rest["aria-label"]}
          aria-labelledby={f["aria-labelledby"] ?? (rest["aria-label"] ? undefined : controlId)}
          className="fixed z-[60] overflow-y-auto overscroll-contain rounded-card border border-control-line bg-bg3 p-1 text-ink shadow-overlay outline-none"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => event.stopPropagation()}
        >
          {choices.map((option, index) => (
            <div
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              aria-disabled={option.disabled || undefined}
              data-selected={option.value === selected?.value || undefined}
              className={cx(
                "flex min-h-9 cursor-default items-center gap-2 rounded-ctl px-2 py-2 text-[13px] [@media(pointer:coarse)]:min-h-11",
                option.disabled ? "cursor-not-allowed text-ink-faint opacity-55" : "text-ink",
                index === active && !option.disabled && "bg-signal-dim outline-2 -outline-offset-2 outline-signal",
              )}
              onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
              onClick={() => { commit(index); trigger.current?.focus(); }}
            >
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              <Check aria-hidden="true" className={cx("h-3.5 w-3.5 shrink-0 text-signal", option.value !== selected?.value && "invisible")} />
            </div>
          ))}
        </div>, document.body,
      )}
    </div>
  );
});

/** Multi-row/multiple controls are native listboxes, not system popup menus. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const f = useFieldProps(props.id, props);
  if (!props.multiple && !(props.size && props.size > 1)) return <DropdownSelect {...props} ref={ref} />;
  const { options, placeholder, className, ...rest } = props;
  return <div className={cx("relative min-w-0", className)}>
    <select {...rest} ref={ref} id={f.id} aria-describedby={f["aria-describedby"]} aria-labelledby={f["aria-labelledby"]}
      aria-invalid={f["aria-invalid"]} aria-required={f["aria-required"]}
      className={cx(CONTROL, "h-auto", f.invalid ? "border-err" : "border-control-line")}>
      {placeholder && <option value="" disabled>{placeholder}</option>}
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
  </div>;
});
