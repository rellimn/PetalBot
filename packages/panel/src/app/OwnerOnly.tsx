import type { ReactNode } from 'react';
import { EmptyState, useUser } from '@petalbot/ui-sdk';

export function OwnerOnly({ children }: { readonly children: ReactNode }) {
  return useUser().role === 'owner' ? (
    children
  ) : (
    <EmptyState title="Not allowed">This page is for owners.</EmptyState>
  );
}
