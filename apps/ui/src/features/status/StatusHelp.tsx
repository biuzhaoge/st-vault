import { useEffect, useId, useRef } from 'react';
import { Icon } from '../../design/Icon';
import { tr } from '../../shared/lib/i18n';
import { popoverPlacement, visiblePopoverViewport } from '../../shared/lib/popover-placement';

export function StatusHelp({
  label,
  description,
  parameter,
  open,
  onOpenChange,
}: {
  label: string;
  description: string;
  parameter?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const hovering = useRef(false);
  const leaveTimer = useRef<number>();
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const show = (): void => {
    window.clearTimeout(leaveTimer.current);
    onOpenChange(true);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    const button = trigger.current;
    const popup = tooltip.current;
    if (!open || !button || !popup?.showPopover) return;
    // The top layer lets help escape the scrollable status panel.
    popup.popover = 'manual';
    popup.showPopover();
    const viewport = visiblePopoverViewport();
    popup.style.maxWidth = `${Math.max(0, viewport.width - 24)}px`;
    const placement = popoverPlacement(
      button.getBoundingClientRect(),
      { width: popup.offsetWidth, height: popup.offsetHeight },
      viewport,
    );
    popup.style.left = `${placement.left}px`;
    popup.style.top = placement.top === undefined ? 'auto' : `${placement.top}px`;
    popup.style.bottom = placement.bottom === undefined ? 'auto' : `${placement.bottom}px`;
    popup.style.maxHeight = `${placement.maxHeight}px`;
    const hide = (): void => change.current(false);
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      hide();
    };
    const dismissOutside = (event: PointerEvent): void => {
      if (!button.parentElement?.contains(event.target as Node)) hide();
    };
    const dismissOnScroll = (event: Event): void => {
      if (event.target !== popup) hide();
    };
    window.addEventListener('keydown', dismissOnEscape, true);
    window.addEventListener('pointerdown', dismissOutside);
    window.addEventListener('resize', hide);
    window.visualViewport?.addEventListener('resize', hide);
    window.addEventListener('scroll', dismissOnScroll, true);
    return () => {
      if (popup.isConnected && popup.matches(':popover-open')) popup.hidePopover();
      window.removeEventListener('keydown', dismissOnEscape, true);
      window.removeEventListener('pointerdown', dismissOutside);
      window.removeEventListener('resize', hide);
      window.visualViewport?.removeEventListener('resize', hide);
      window.removeEventListener('scroll', dismissOnScroll, true);
    };
  }, [open]);

  return (
    <span
      className="status-help"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        hovering.current = true;
        show();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return;
        hovering.current = false;
        if (trigger.current?.matches(':focus-visible')) return;
        leaveTimer.current = window.setTimeout(() => change.current(false), 160);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="status-help-trigger"
        aria-label={tr('{{v0}}说明', { v0: label })}
        aria-describedby={id}
        onFocus={show}
        onBlur={() => {
          if (!hovering.current) onOpenChange(false);
        }}
        onClick={show}
      >
        <Icon name="info" />
      </button>
      <span ref={tooltip} id={id} className="status-help-popup" role="tooltip">
        {description}
        {parameter && <small>{parameter}</small>}
      </span>
    </span>
  );
}
