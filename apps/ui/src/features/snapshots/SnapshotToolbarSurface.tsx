import { Component, createRef, type PointerEvent, type ReactNode } from 'react';
import { prefersReducedMotion } from '../../design/use-reduced-motion';

interface Props {
  selecting: boolean;
  busy: boolean;
  label: string;
  children: ReactNode;
}

/** An outgoing label is decoration. Never leave duplicate controls or focus stops in the tree. */
function departingLabels(row: HTMLElement): HTMLDivElement {
  const echo = document.createElement('div');
  echo.className = 'snapshot-toolbar-echo';
  echo.setAttribute('aria-hidden', 'true');
  echo.inert = true;
  const bounds = row.getBoundingClientRect();
  echo.style.width = bounds.width + 'px';
  for (const item of row.querySelectorAll('.snapshot-total, output, button')) {
    const rect = item.getBoundingClientRect();
    const label = document.createElement('span');
    label.style.left = rect.left - bounds.left + 'px';
    label.style.width = rect.width + 'px';
    const icon = item.querySelector('svg');
    if (icon) {
      const copy = icon.cloneNode(true) as SVGElement;
      copy.style.transform = getComputedStyle(icon).transform;
      label.append(copy);
    }
    label.append(item.textContent ?? '');
    echo.append(label);
  }
  return echo;
}

interface BeforeUpdate {
  focused: Element | null;
  echo?: HTMLDivElement;
}

export class SnapshotToolbarSurface extends Component<Props, object, BeforeUpdate> {
  private nav = createRef<HTMLElement>();
  private row = createRef<HTMLDivElement>();
  private observer?: ResizeObserver;
  private press?: { button: HTMLButtonElement; center: number; cleanup: AbortController };

  override componentDidMount(): void {
    const nav = this.nav.current!;
    const measure = () => {
      nav.style.setProperty('--snapshot-shell-width', nav.offsetWidth + 'px');
    };
    measure();
    this.observer = new ResizeObserver(measure);
    this.observer.observe(nav);
  }

  override getSnapshotBeforeUpdate(previous: Props): BeforeUpdate {
    const focused = document.activeElement;
    return {
      focused: this.nav.current!.contains(focused) ? focused : null,
      echo:
        previous.selecting !== this.props.selecting && !prefersReducedMotion()
          ? departingLabels(this.row.current!)
          : undefined,
    };
  }

  override componentDidUpdate(_previous: Props, _state: object, snapshot: BeforeUpdate): void {
    const nav = this.nav.current!;
    const row = this.row.current!;
    if (snapshot.echo) {
      const echo = snapshot.echo;
      nav.querySelector('.snapshot-toolbar-echo')?.remove();
      nav.append(echo);
      const animation = echo.getAnimations()[0];
      if (animation)
        void animation.finished.then(
          () => echo.remove(),
          () => echo.remove(),
        );
      else echo.remove();
    }
    if (
      snapshot.focused &&
      snapshot.focused !== nav &&
      (!row.contains(snapshot.focused) || snapshot.focused.matches(':disabled'))
    ) {
      // Recover to Clear/another page, or to the landmark when its only actions are destructive.
      const target = this.props.selecting
        ? '.snapshot-actions button:enabled'
        : '.snapshot-page-button:enabled';
      (row.querySelector<HTMLButtonElement>(target) ?? nav).focus({ preventScroll: true });
    }
    if (this.press && row.contains(this.press.button)) {
      // A status or count update can resize the centered row between pointerdown and click.
      nav.style.translate = '';
      const box = this.press.button.getBoundingClientRect();
      nav.style.translate = this.press.center - box.left - box.width / 2 + 'px';
    }
  }

  override componentWillUnmount(): void {
    this.observer?.disconnect();
    this.endPress();
  }

  private endPress = (): void => {
    this.press?.cleanup.abort();
    this.press = undefined;
    if (this.nav.current) this.nav.current.style.translate = '';
  };

  private startPress = (event: PointerEvent<HTMLElement>): void => {
    const button = (event.target as Element).closest('button');
    if (!event.isPrimary || event.button !== 0 || !button || button.disabled) return;
    this.endPress();
    const box = button.getBoundingClientRect();
    const cleanup = new AbortController();
    this.press = { button, center: box.left + box.width / 2, cleanup };
    const finish = (up: globalThis.PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      // Keep native hit testing stable through the following click dispatch.
      requestAnimationFrame(() => {
        if (this.press?.cleanup === cleanup) this.endPress();
      });
    };
    window.addEventListener('pointerup', finish, { capture: true, signal: cleanup.signal });
    window.addEventListener('pointercancel', finish, { capture: true, signal: cleanup.signal });
    window.addEventListener('blur', this.endPress, { signal: cleanup.signal });
  };

  override render(): JSX.Element {
    return (
      <nav
        ref={this.nav}
        className={this.props.selecting ? 'snapshot-pages is-selecting' : 'snapshot-pages'}
        tabIndex={-1}
        aria-label={this.props.label}
        aria-busy={this.props.busy}
        onPointerDownCapture={this.startPress}
      >
        <div
          className="snapshot-toolbar-controls"
          key={String(this.props.selecting)}
          ref={this.row}
        >
          {this.props.children}
        </div>
      </nav>
    );
  }
}
