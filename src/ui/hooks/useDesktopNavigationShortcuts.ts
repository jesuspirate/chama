import { useEffect } from "react";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT";
}

function visibleShortcut(action: "enter" | "back"): HTMLButtonElement | null {
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  // A funding/claim/vote dialog may sit over an otherwise safe wizard button.
  // Once a modal is open, scope shortcuts to that modal; because money dialogs
  // deliberately expose no shortcut attributes, Enter then becomes a no-op.
  const modal = [...document.querySelectorAll<HTMLElement>(
    'dialog[open], [role="dialog"], [aria-modal="true"]',
  )].reverse().find(visible);
  const root: ParentNode = modal ?? document;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>(
    `button[data-chama-shortcut="${action}"]`,
  )];
  return buttons.reverse().find((button) => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    return visible(button);
  }) ?? null;
}

/**
 * Desktop-only keyboard navigation. Nothing is inferred from button copy:
 * screens must explicitly opt a safe button in with data-chama-shortcut.
 * Publish, vote, claim, fund and other money/consensus actions never opt in.
 */
export function useDesktopNavigationShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "Enter") {
        if (event.shiftKey || (event.target instanceof HTMLTextAreaElement)) return;
        const button = visibleShortcut("enter");
        if (!button) return;
        event.preventDefault();
        button.click();
        return;
      }

      const isBack = event.key === "Escape"
        || event.key === "BrowserBack"
        || (event.key === "Backspace" && !isEditable(event.target));
      if (!isBack) return;
      const button = visibleShortcut("back");
      if (!button) return;
      event.preventDefault();
      button.click();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
