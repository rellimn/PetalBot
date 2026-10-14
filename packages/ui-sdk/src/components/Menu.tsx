import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactElement } from 'react';
import { IconButton } from './IconButton.tsx';
import type { IconComponent } from './icon.ts';
import styles from './Menu.module.css';

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly tone?: 'danger';
  readonly disabled?: boolean;
  readonly icon?: IconComponent;
}

export interface MenuProps {
  /** Accessible name of the default "..." trigger. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** A custom trigger element (must accept a ref, like Button). */
  readonly trigger?: ReactElement;
}

export function Menu({ label, items, trigger }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {trigger ?? <IconButton label={label} icon={MoreHorizontal} />}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.content} align="end" sideOffset={4}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenu.Item
                key={item.label}
                className={styles.item}
                data-tone={item.tone}
                disabled={item.disabled === true}
                onSelect={() => {
                  item.onSelect();
                }}
              >
                {Icon ? <Icon size={14} aria-hidden /> : null}
                {item.label}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
