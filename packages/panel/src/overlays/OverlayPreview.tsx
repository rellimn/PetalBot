import { useEffect, useRef, useState } from 'react';
import { Field, Select } from '@petalbot/ui-sdk';
import styles from './overlays.module.css';

type Aspect = '16:9' | '9:16' | '4:3';
type Backdrop = 'checker' | 'dark' | 'light';

interface PreviewPrefs {
  readonly aspect: Aspect;
  readonly backdrop: Backdrop;
}

/** The OBS canvas sizes the overlay is rendered at before scaling. */
const FRAMES: Readonly<Record<Aspect, readonly [number, number]>> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '4:3': [1440, 1080],
};
const ASPECTS: readonly Aspect[] = ['16:9', '9:16', '4:3'];
const BACKDROPS: readonly { readonly value: Backdrop; readonly label: string }[] = [
  { value: 'checker', label: 'Checkerboard' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const MAX_HEIGHT = 540;
const STORAGE_KEY = 'petalbot.overlay-preview';
const DEFAULT_PREFS: PreviewPrefs = { aspect: '16:9', backdrop: 'checker' };

const isAspect = (value: unknown): value is Aspect => ASPECTS.some((aspect) => aspect === value);
const isBackdrop = (value: unknown): value is Backdrop =>
  BACKDROPS.some((backdrop) => backdrop.value === value);

function loadPrefs(): PreviewPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<
      Record<keyof PreviewPrefs, unknown>
    > | null;
    return {
      aspect: isAspect(stored?.aspect) ? stored.aspect : DEFAULT_PREFS.aspect,
      backdrop: isBackdrop(stored?.backdrop) ? stored.backdrop : DEFAULT_PREFS.backdrop,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: PreviewPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked (private mode): the choice is just not remembered.
  }
}

/** The overlay page in an iframe at OBS size, scaled to the pane, over a chosen backdrop. */
export function OverlayPreview({ src, title }: { readonly src: string; readonly title: string }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [width, setWidth] = useState(0);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const [frameWidth, frameHeight] = FRAMES[prefs.aspect];
  const scale = width > 0 ? Math.min(width / frameWidth, MAX_HEIGHT / frameHeight) : 0;
  const update = (next: PreviewPrefs): void => {
    setPrefs(next);
    savePrefs(next);
  };

  return (
    <section className={styles.preview} aria-label="Live preview">
      <div className={styles.previewBar}>
        <h3>Preview</h3>
        <Field label="Aspect">
          <Select
            options={ASPECTS.map((aspect) => ({ value: aspect, label: aspect }))}
            value={prefs.aspect}
            onChange={(event) => {
              const aspect = event.target.value;
              if (isAspect(aspect)) update({ ...prefs, aspect });
            }}
          />
        </Field>
        <Field label="Background">
          <Select
            options={BACKDROPS}
            value={prefs.backdrop}
            onChange={(event) => {
              const backdrop = event.target.value;
              if (isBackdrop(backdrop)) update({ ...prefs, backdrop });
            }}
          />
        </Field>
      </div>
      <div
        ref={stage}
        className={styles.stage}
        data-backdrop={prefs.backdrop}
        style={{ height: frameHeight * scale }}
      >
        <iframe
          title={title}
          src={src}
          className={styles.frame}
          // color-scheme must match the overlay page's, or browsers paint the frame opaque.
          style={{
            width: frameWidth,
            height: frameHeight,
            transform: `scale(${String(scale)})`,
            colorScheme: 'normal',
          }}
        />
      </div>
    </section>
  );
}
