import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Star } from 'lucide-react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Menu,
  Select,
  Spinner,
  StatusDot,
  Switch,
  Toaster,
  toast,
  useToast,
} from '../src/index.ts';

describe('Button and IconButton', () => {
  it('clicks, and is busy and disabled while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" icon={Star} onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <Button variant="primary" loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Save/ });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.dataset.variant).toBe('primary');
  });

  it('names icon buttons by their label', () => {
    render(<IconButton label="Reload" icon={Star} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});

describe('form controls', () => {
  it('wires labels, help and errors to the control', () => {
    render(
      <Field label="Volume" help="0 to 100" error="Too loud">
        <Input type="number" defaultValue={500} />
      </Field>,
    );
    const input = screen.getByLabelText('Volume');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['0 to 100', 'Too loud']);
  });

  it('selects options, toggles switches and checkboxes', async () => {
    const onChange = vi.fn();
    function Controls() {
      const [on, setOn] = useState(false);
      const [checked, setChecked] = useState(false);
      return (
        <>
          <Field label="Mode">
            <Select
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              defaultValue="dark"
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
          </Field>
          <Switch label="Enabled" checked={on} onCheckedChange={setOn} />
          <Checkbox label="Compact" checked={checked} onCheckedChange={setChecked} />
        </>
      );
    }
    render(<Controls />);
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'light');
    expect(onChange).toHaveBeenCalledWith('light');
    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Compact' }));
    expect(screen.getByRole('checkbox', { name: 'Compact' })).toHaveProperty('checked', true);
  });
});

describe('dialogs and menus', () => {
  it('only confirms after the required text was typed', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete plugin data?"
        message="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        requireText="quotes"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Type quotes to confirm'), 'quotes');
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('runs menu items', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Actions for quotes"
        items={[
          { label: 'Reload', onSelect },
          { label: 'Delete data…', onSelect: () => undefined, tone: 'danger', disabled: true },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actions for quotes' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reload' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe('feedback', () => {
  it('shows toasts pushed with useToast and dismisses them', async () => {
    function Saver() {
      const toast = useToast();
      return (
        <Button
          onClick={() => {
            toast({ title: 'Saved', tone: 'success' });
          }}
        >
          Save
        </Button>
      );
    }
    render(
      <Toaster>
        <Saver />
      </Toaster>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Saved')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('shows toasts pushed with toast() from outside components, five at most', () => {
    render(
      <Toaster>
        <p>page</p>
      </Toaster>,
    );
    act(() => {
      for (let index = 1; index <= 6; index += 1) toast({ title: `Toast ${String(index)}` });
    });
    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.getByText('Toast 2')).toBeTruthy();
    expect(screen.getByText('Toast 6')).toBeTruthy();
  });

  it('drops toasts when the last Toaster unmounts', async () => {
    const first = render(
      <Toaster>
        <p>first</p>
      </Toaster>,
    );
    act(() => {
      toast({ title: 'Left over' });
    });
    first.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    render(
      <Toaster>
        <p>second</p>
      </Toaster>,
    );
    expect(screen.queryByText('Left over')).toBeNull();
  });

  it('keeps toasts across a StrictMode remount', async () => {
    act(() => {
      toast({ title: 'Early' });
    });
    render(
      <StrictMode>
        <Toaster>
          <p>strict</p>
        </Toaster>
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Early')).toBeTruthy();
  });

  it('announces banners, dots and spinners', () => {
    render(
      <>
        <Banner tone="danger">Plugin crashed</Banner>
        <Banner tone="info">Reconnecting…</Banner>
        <StatusDot tone="danger" label="1 plugin failed" />
        <Spinner />
      </>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Plugin crashed');
    expect(screen.getAllByRole('status').map((element) => element.textContent)).toContain(
      'Reconnecting…',
    );
    expect(screen.getByRole('img', { name: '1 plugin failed' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });
});
