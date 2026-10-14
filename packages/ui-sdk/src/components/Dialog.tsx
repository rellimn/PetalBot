import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import styles from './Dialog.module.css';
import { Field } from './Field.tsx';
import { IconButton } from './IconButton.tsx';
import { Input } from './Input.tsx';

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons, right-aligned. */
  readonly footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <header className={styles.header}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label="Close" icon={X} size="md" />
            </RadixDialog.Close>
          </header>
          {description !== undefined ? (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
          {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly tone?: 'danger' | 'primary';
  readonly busy?: boolean;
  /** The user must type this text before confirming (destructive actions). */
  readonly requireText?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = 'primary',
  busy = false,
  requireText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const ready = requireText === undefined || typed === requireText;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('');
          onCancel();
        }
      }}
      title={title}
      description={message}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setTyped('');
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            variant={tone}
            loading={busy}
            disabled={!ready}
            onClick={() => {
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireText !== undefined ? (
        <Field label={`Type ${requireText} to confirm`}>
          <Input
            value={typed}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </Field>
      ) : null}
    </Dialog>
  );
}
