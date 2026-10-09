/**
 * Reduced motion: `auto` has to stay reachable (DUB-78, spec on DUB-74).
 *
 * `settings.reducedMotion` is three-state but the control is a two-state
 * switch, so before this change one tap made `auto` unreachable — and on a
 * device that asks to reduce motion that tap resolved to `off`, turning motion
 * *on* against the device's request. The only way back was Settings → Reset
 * club, which deletes the save.
 *
 * How this renders without a DOM: the vitest environment here is `node` by
 * design, and `renderToStaticMarkup` is no use on its own — it drops event
 * handlers, and zustand maps React's server snapshot to the store's *boot*
 * state, so the sheet would render as `auto` whatever the test set. So the
 * store module is faked with a plain selector over a test object, and the
 * component is invoked inside a throwaway host component, where React's hook
 * dispatcher is live. That hands back the real element tree: handlers
 * attached, and renderable to markup when the assertion is about markup.
 */
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SavedSettings } from '../save/schema.ts';
import type * as StoreModule from '../state/store.ts';

const fake = vi.hoisted((): { state: Record<string, unknown> } => ({ state: {} }));

vi.mock('../state/store.ts', () => ({
  useGameStore: (selector: (s: Record<string, unknown>) => unknown) => selector(fake.state),
}));

const { SettingsSheet } = await import('./SettingsSheet.tsx');

const REVERT_LABEL = 'Follow my device setting';
const REVERT_ARIA = 'Reduced motion: follow my device setting';

interface Rendered {
  readonly tree: ReactElement;
  readonly settings: SavedSettings;
  readonly setSettings: ReturnType<typeof vi.fn>;
  readonly resetSave: ReturnType<typeof vi.fn>;
}

/** Render the sheet with the reduced-motion setting at `reducedMotion`. */
function renderWith(reducedMotion: SavedSettings['reducedMotion']): Rendered {
  const settings: SavedSettings = { ...DEFAULT_SETTINGS, reducedMotion };
  const setSettings = vi.fn();
  const resetSave = vi.fn();

  fake.state = {
    closeSheet: vi.fn(),
    settings,
    setSettings,
    actions: { resetSave },
    storageUnavailable: false,
  };

  let captured: ReactElement | null = null;
  function Host(): null {
    captured = SettingsSheet();
    return null;
  }
  renderToStaticMarkup(createElement(Host));

  if (captured === null) throw new Error('the sheet rendered nothing');
  return { tree: captured, settings, setSettings, resetSave };
}

/** Depth-first search of an element tree for the first node with `className`. */
function findByClass(node: ReactNode, className: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child as ReactNode, className);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return null;

  const element = node as ReactElement<{ className?: string; children?: ReactNode }>;
  if (element.props.className === className) return element;
  return findByClass(element.props.children, className);
}

function revertButton(rendered: Rendered): ReactElement<{
  'aria-label': string;
  children: ReactNode;
  onPointerDown: () => void;
  onClick: (event: { detail: number }) => void;
}> | null {
  return findByClass(rendered.tree, 'setting-revert') as ReactElement<{
    'aria-label': string;
    children: ReactNode;
    onPointerDown: () => void;
    onClick: (event: { detail: number }) => void;
  }> | null;
}

describe('the "Follow my device setting" action', () => {
  it('is not rendered while the setting is already auto', () => {
    const rendered = renderWith('auto');

    expect(revertButton(rendered)).toBeNull();
    expect(renderToStaticMarkup(rendered.tree)).not.toContain(REVERT_LABEL);
  });

  it.each(['on', 'off'] as const)('is rendered when the setting is overridden to %s', (value) => {
    const rendered = renderWith(value);
    const button = revertButton(rendered);

    expect(button).not.toBeNull();
    expect(button?.props.children).toBe(REVERT_LABEL);
    expect(button?.props['aria-label']).toBe(REVERT_ARIA);
    // WCAG 2.5.3: the visible label has to be inside the accessible name.
    expect(REVERT_ARIA.toLowerCase()).toContain(REVERT_LABEL.toLowerCase());
  });

  it('is a sibling of the switch, not a button nested inside one', () => {
    const rendered = renderWith('on');
    const group = findByClass(rendered.tree, 'setting-group');
    const children = (group?.props as { children?: ReactNode }).children;

    // A nested button is invalid HTML and unreachable by tap, so the action
    // has to be a direct child of the group alongside the toggle.
    expect(Array.isArray(children)).toBe(true);
    expect(children).toContain(revertButton(rendered));

    const markup = renderToStaticMarkup(rendered.tree);
    const switchAt = markup.indexOf('role="switch" aria-checked="true"');
    expect(markup.indexOf('</button>', switchAt)).toBeLessThan(markup.indexOf('setting-revert'));
  });

  it('leaves the reduced-motion hint strings exactly as they were written', () => {
    expect(renderToStaticMarkup(renderWith('auto').tree)).toContain(
      'Following your device setting. Shake and confetti become a flash.',
    );
    expect(renderToStaticMarkup(renderWith('off').tree)).toContain(
      'Shake and confetti become a flash. Feedback is never removed.',
    );
  });
});

describe('activating it returns the setting to auto', () => {
  it.each(['on', 'off'] as const)('writes auto from %s on a tap', (from) => {
    const rendered = renderWith(from);

    revertButton(rendered)?.props.onPointerDown();

    expect(rendered.setSettings).toHaveBeenCalledTimes(1);
    expect(rendered.setSettings).toHaveBeenCalledWith({
      ...rendered.settings,
      reducedMotion: 'auto',
    });
  });

  it.each(['on', 'off'] as const)('writes auto from %s on a keyboard press', (from) => {
    const rendered = renderWith(from);

    // Keyboard activation synthesises a click with `detail === 0`.
    revertButton(rendered)?.props.onClick({ detail: 0 });

    expect(rendered.setSettings).toHaveBeenCalledWith({
      ...rendered.settings,
      reducedMotion: 'auto',
    });
  });

  it('does not fire twice when a tap is followed by its own click', () => {
    const rendered = renderWith('off');
    const button = revertButton(rendered);

    button?.props.onPointerDown();
    // The click a pointer produces carries a non-zero detail, so the guard
    // drops it rather than writing the setting a second time.
    button?.props.onClick({ detail: 1 });

    expect(rendered.setSettings).toHaveBeenCalledTimes(1);
  });

  it('patches the settings rather than resetting the club', () => {
    const rendered = renderWith('on');
    fake.state['settings'] = { audio: false, reducedMotion: 'on', haptics: false };

    const after = renderWith('on');
    revertButton(after)?.props.onPointerDown();

    // Every sibling setting rides along untouched, and nothing calls the
    // destructive path — the saved club survives.
    expect(after.setSettings.mock.calls[0]?.[0]).toEqual({
      ...after.settings,
      reducedMotion: 'auto',
    });
    expect(after.resetSave).not.toHaveBeenCalled();
    expect(rendered.resetSave).not.toHaveBeenCalled();
  });
});

describe('the action introduces no motion of its own', () => {
  const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('.setting-revert {'), css.indexOf('.settings-reset {'));

  it('declares no transition, animation or transform', () => {
    // A control whose job is to restore the device's reduce-motion request
    // must not animate. That is also why it needs no `prefers-reduced-motion`
    // rule of its own.
    expect(block).not.toMatch(/\b(transition|animation|transform)\s*:/);
  });

  it('is at least one touch target tall', () => {
    expect(block).toContain('min-height: var(--touch-min);');
  });

  it('adds exactly one length literal — the optical underline offset', () => {
    const literals = block.match(/:[^;]*\b\d+(?:px|rem|em)\b/g) ?? [];

    expect(literals).toHaveLength(1);
    expect(literals[0]).toContain('2px');
  });
});

describe('the real store keeps the club when only the settings change', () => {
  it('leaves the club fields alone', async () => {
    const { useGameStore } = await vi.importActual<typeof StoreModule>('../state/store.ts');

    useGameStore.setState({
      cash: 4200,
      purchaseCount: 7,
      settings: { ...DEFAULT_SETTINGS, reducedMotion: 'off' },
    });

    const { settings, setSettings } = useGameStore.getState();
    setSettings({ ...settings, reducedMotion: 'auto' });

    const after = useGameStore.getState();
    expect(after.settings.reducedMotion).toBe('auto');
    expect(after.cash).toBe(4200);
    expect(after.purchaseCount).toBe(7);
  });
});
