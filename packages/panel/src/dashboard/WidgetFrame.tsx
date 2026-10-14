import type { z } from 'zod';
import { choiceOf } from '@petalbot/sdk';
import { Button, Card, Spinner, usePlugin, useUser, type PanelWidget } from '@petalbot/ui-sdk';
import type { WidgetInstance } from '../app/endpoints.ts';
import { hasRole } from '../app/roles.ts';
import { PluginBoundary } from '../plugins/PluginBoundary.tsx';
import { useKnownPanel, usePanel } from '../plugins/registry.ts';
import { useChoices } from '../settings/choices.ts';
import styles from './dashboard.module.css';

function Placeholder({ text }: { readonly text: string }) {
  return (
    <Card className={styles.placeholder}>
      <p>{text}</p>
    </Card>
  );
}

/** "Title · Label" from the config's first choice() field, so instances can be told apart. */
function useInstanceTitle(
  widget: PanelWidget | undefined,
  config: Readonly<Record<string, unknown>> | undefined,
  title: string,
): string {
  const field = Object.entries<z.core.$ZodType>(widget?.config?.shape ?? {})
    .map(([key, schema]) => ({ key, rpc: choiceOf(schema) }))
    .find((entry) => entry.rpc !== undefined);
  const choices = useChoices(field?.rpc);
  const value = field ? config?.[field.key] : undefined;
  if (typeof value !== 'string' || choices.data === undefined) return title;
  const label = choices.data.find((choice) => choice.value === value)?.label;
  return `${title} · ${label ?? '(deleted)'}`;
}

export interface WidgetFrameProps {
  readonly instance: WidgetInstance;
  /** Opens the configure dialog. Omitted inside the editor preview, which is inert. */
  readonly onConfigure?: () => void;
}

/** One placed widget. Missing or stopped widgets keep their slot as a muted placeholder. */
export function WidgetFrame({ instance, onConfigure }: WidgetFrameProps) {
  const info = usePlugin(instance.plugin);
  const state = usePanel(instance.plugin);
  const known = useKnownPanel(instance.plugin);
  const user = useUser();
  const loaded = state?.status === 'ready' ? state.panel : undefined;
  const widget = (loaded ?? known)?.widgets.find((candidate) => candidate.id === instance.widget);
  const title = useInstanceTitle(
    widget,
    instance.config,
    widget?.title ?? `${instance.plugin} / ${instance.widget}`,
  );

  if (info?.state !== 'running') return <Placeholder text={`${title} — plugin not running`} />;
  if (!state || state.status === 'loading') {
    return (
      <Card title={title}>
        <Spinner label={`Loading ${title}`} />
      </Card>
    );
  }
  if (state.status === 'error') return <Placeholder text={`${title} — could not be loaded`} />;
  const current = state.panel.widgets.find((candidate) => candidate.id === instance.widget);
  if (!current) return <Placeholder text={`${title} — this widget no longer exists`} />;
  if (!hasRole(user.role, current.minRole ?? 'owner')) {
    return <Placeholder text={`${title} — not available to you`} />;
  }
  // The component only ever gets a config that parses (with defaults applied).
  const parsed = current.config?.safeParse(instance.config ?? {});
  if (parsed !== undefined && !parsed.success) {
    return (
      <Card title={title} className={styles.placeholder}>
        <p>Needs configuration</p>
        {onConfigure ? (
          <Button size="sm" onClick={onConfigure}>
            Configure
          </Button>
        ) : null}
      </Card>
    );
  }
  return (
    <Card title={title}>
      <PluginBoundary key={state.entry} pluginId={instance.plugin} label={current.title}>
        <current.component config={parsed?.data ?? {}} instanceId={instance.id} />
      </PluginBoundary>
    </Card>
  );
}
