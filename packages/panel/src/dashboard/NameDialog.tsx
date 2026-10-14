import { useId, useState } from 'react';
import { Button, Dialog, Field, Input } from '@petalbot/ui-sdk';

export interface NameDialogProps {
  readonly title: string;
  readonly initial: string;
  readonly confirmLabel: string;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}

/** Asks for a preset name (1-40 characters). Mount it only while it is open. */
export function NameDialog({ title, initial, confirmLabel, onSubmit, onCancel }: NameDialogProps) {
  const formId = useId();
  const [name, setName] = useState(initial);
  const valid = name.trim().length > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={!valid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(name.trim());
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            maxLength={40}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}
