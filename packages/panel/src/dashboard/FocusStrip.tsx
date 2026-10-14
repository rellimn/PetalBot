import { Minimize2 } from 'lucide-react';
import { Button, Select } from '@petalbot/ui-sdk';
import type { Preset } from '../app/endpoints.ts';
import { HealthDot } from '../shell/HealthDot.tsx';
import { useFocus } from '../shell/focus.ts';
import styles from './dashboard.module.css';

export interface FocusStripProps {
  readonly presets: readonly Preset[];
  readonly active: Preset;
  readonly onSelect: (id: string) => void;
}

/** The only chrome in focus mode: exit, preset picker, health (amber when offline). */
export function FocusStrip({ presets, active, onSelect }: FocusStripProps) {
  const { setFocused } = useFocus();
  return (
    <div className={styles.strip} role="toolbar" aria-label="Focus mode">
      <Button
        size="sm"
        variant="ghost"
        icon={Minimize2}
        onClick={() => {
          setFocused(false);
        }}
      >
        Exit
      </Button>
      <Select
        aria-label="Preset"
        value={active.id}
        options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
        onChange={(event) => {
          onSelect(event.target.value);
        }}
      />
      <span className={styles.spacer} />
      <HealthDot showConnection />
    </div>
  );
}
