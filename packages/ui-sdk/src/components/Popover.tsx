import { Popover as RadixPopover } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import styles from './Popover.module.css';

export interface PopoverProps {
  /** The element that opens the popover (must accept a ref, like Button). */
  readonly trigger: ReactElement;
  /** Accessible name of the popover content. */
  readonly label?: string;
  readonly align?: 'start' | 'center' | 'end';
  readonly children: ReactNode;
}

export function Popover({ trigger, label, align = 'end', children }: PopoverProps) {
  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={styles.content}
          align={align}
          sideOffset={6}
          {...(label === undefined ? {} : { 'aria-label': label })}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
