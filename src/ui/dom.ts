type Attrs = Record<string, string | undefined> & { text?: string; html?: string };

/** Tiny element helper: h('button', { class: 'btn', text: 'OK' }, [children]). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  if (tag === 'button' && !attrs.type) el.setAttribute('type', 'button');
  el.append(...children);
  return el;
}

/** Whether an element brings up the on-screen keyboard when focused. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'].includes(el.type);
}

/**
 * Take the focus away from a text field (closing the on-screen keyboard). Otherwise
 * a field that kept the focus – e.g. after a dialog closed – can make iPadOS show
 * the keyboard (or Scribble) again while drawing with the Pencil.
 */
export function releaseTextFocus(): void {
  const a = document.activeElement;
  if (isTextField(a)) (a as HTMLElement).blur();
}
