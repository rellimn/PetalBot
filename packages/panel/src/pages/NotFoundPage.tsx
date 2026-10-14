import { Link } from '@tanstack/react-router';
import { EmptyState } from '@petalbot/ui-sdk';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found" action={<Link to="/">Go to the dashboard</Link>}>
      There is nothing at this address.
    </EmptyState>
  );
}
