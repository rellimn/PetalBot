import { Maximize2, Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Menu,
  Select,
  Spinner,
  usePlugins,
  usePluginsLoaded,
  useUser,
} from '@petalbot/ui-sdk';
import { usePreferences, useSavePreferences } from '../app/preferences.ts';
import { errorText } from '../plugins/actions.tsx';
import { usePanels } from '../plugins/registry.ts';
import { useFocus } from '../shell/focus.ts';
import { usePresetActions, usePresets } from './api.ts';
import { DashboardView } from './DashboardView.tsx';
import styles from './dashboard.module.css';
import { FocusStrip } from './FocusStrip.tsx';
import { NameDialog } from './NameDialog.tsx';
import { PresetEditor } from './PresetEditor.tsx';
import { availableWidgets, bundlesSettled, starterPreset } from './widgets.ts';

type DialogState = 'new' | 'rename' | 'delete' | null;

export function DashboardPage() {
  const user = useUser();
  const plugins = usePlugins();
  const pluginsLoaded = usePluginsLoaded();
  const panels = usePanels();
  const presets = usePresets();
  const actions = usePresetActions();
  const preferences = usePreferences();
  const savePreferences = useSavePreferences();
  const { focused, setFocused } = useFocus();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [editing, setEditing] = useState(false);
  const [starterFailed, setStarterFailed] = useState(false);
  const starterStarted = useRef(false);

  const list = presets.data;
  const settled = pluginsLoaded && bundlesSettled(plugins, panels);

  const createStarter = async (): Promise<void> => {
    starterStarted.current = true;
    setStarterFailed(false);
    const created = await actions.create(starterPreset(availableWidgets(panels, user.role)));
    if (!created) setStarterFailed(true);
  };

  useEffect(() => {
    if (list === undefined || list.length > 0 || !settled || starterStarted.current) return;
    starterStarted.current = true;
    void actions.create(starterPreset(availableWidgets(panels, user.role))).then((created) => {
      if (!created) setStarterFailed(true);
    });
  }, [list, settled, panels, user.role, actions]);

  if (presets.isPending) return <Spinner label="Loading the dashboard" />;
  if (presets.isError) {
    return (
      <EmptyState title="The dashboard could not be loaded">{errorText(presets.error)}</EmptyState>
    );
  }
  const all = presets.data;
  const active = all.find((preset) => preset.id === preferences.activePreset) ?? all[0];
  if (active === undefined) {
    return starterFailed ? (
      <EmptyState
        title="Your dashboard could not be created"
        action={
          <Button
            variant="primary"
            onClick={() => {
              void createStarter();
            }}
          >
            Try again
          </Button>
        }
      />
    ) : (
      <Spinner label="Preparing your dashboard" />
    );
  }

  const select = (id: string): void => {
    savePreferences({ ...preferences, activePreset: id });
  };

  if (editing && !focused) {
    return (
      <div className={styles.dashboard}>
        <PresetEditor
          key={active.id}
          preset={active}
          onDone={() => {
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      {focused ? (
        <FocusStrip presets={all} active={active} onSelect={select} />
      ) : (
        <div className={styles.toolbar}>
          <h1 className={styles.srOnly}>Dashboard</h1>
          <div className={styles.presetPicker}>
            <Field label="Preset">
              <Select
                value={active.id}
                options={all.map((preset) => ({ value: preset.id, label: preset.name }))}
                onChange={(event) => {
                  select(event.target.value);
                }}
              />
            </Field>
          </div>
          <span className={styles.spacer} />
          <Button
            icon={Pencil}
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            icon={Maximize2}
            onClick={() => {
              setFocused(true);
            }}
          >
            Focus
          </Button>
          <Menu
            label="Preset actions"
            items={[
              {
                label: 'New preset…',
                onSelect: () => {
                  setDialog('new');
                },
              },
              {
                label: 'Rename…',
                onSelect: () => {
                  setDialog('rename');
                },
              },
              {
                label: 'Delete preset…',
                tone: 'danger',
                disabled: all.length === 1,
                onSelect: () => {
                  setDialog('delete');
                },
              },
            ]}
          />
        </div>
      )}
      <DashboardView preset={active} />
      {dialog === 'new' ? (
        <NameDialog
          title="New preset"
          initial=""
          confirmLabel="Create"
          onCancel={() => {
            setDialog(null);
          }}
          onSubmit={(name) => {
            setDialog(null);
            void actions.create({ name, columns: [{ width: 1, widgets: [] }] }).then((preset) => {
              if (preset) select(preset.id);
            });
          }}
        />
      ) : null}
      {dialog === 'rename' ? (
        <NameDialog
          title="Rename preset"
          initial={active.name}
          confirmLabel="Save"
          onCancel={() => {
            setDialog(null);
          }}
          onSubmit={(name) => {
            setDialog(null);
            void actions.update(active.id, { name, columns: active.columns });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Delete the preset ${active.name}?`}
        message="Only this preset is deleted; the widgets and their plugins stay."
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => {
          setDialog(null);
        }}
        onConfirm={() => {
          setDialog(null);
          void actions.remove(active.id);
        }}
      />
    </div>
  );
}
