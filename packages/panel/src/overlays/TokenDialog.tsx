import { Copy } from 'lucide-react';
import { Button, Dialog, Field, Input, useToast } from '@petalbot/ui-sdk';

/** Shows an overlay URL with its token: the only time it is visible. */
export function TokenDialog({
  title,
  url,
  onClose,
}: {
  readonly title: string;
  readonly url: string;
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'URL copied', tone: 'success' });
    } catch {
      // No clipboard (e.g. plain http on another host): the field selects itself on focus.
      toast({
        title: 'Copying failed',
        description: 'Select the URL and copy it by hand.',
        tone: 'warning',
      });
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description="Add this URL as a browser source in OBS. It contains the access token and is shown only now."
      footer={
        <>
          <Button
            icon={Copy}
            onClick={() => {
              void copy();
            }}
          >
            Copy URL
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Field label="Browser source URL">
        <Input
          readOnly
          value={url}
          onFocus={(event) => {
            event.target.select();
          }}
        />
      </Field>
    </Dialog>
  );
}
