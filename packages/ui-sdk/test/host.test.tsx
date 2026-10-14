import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChoices } from '../src/host.ts';
import { renderWithPetal } from './render.tsx';

function Picker({ rpc }: { readonly rpc: string | undefined }) {
  const choices = useChoices(rpc);
  return <p>choices: {choices.data?.map((choice) => choice.label).join(', ') ?? '-'}</p>;
}

describe('useChoices', () => {
  it('sends nothing without a choice RPC', async () => {
    const { socket } = renderWithPetal(<Picker rpc={undefined} />);
    expect(await screen.findByText('choices: -')).toBeTruthy();
    expect(socket.ofType('rpc')).toEqual([]);
  });

  it('queries a choice RPC no client declared (a plugin without a panel)', async () => {
    const { socket } = renderWithPetal(<Picker rpc="bare.options" />);
    await waitFor(() => {
      expect(socket.ofType('rpc')).toMatchObject([{ name: 'bare.options' }]);
    });
    act(() => {
      socket.answer('rpc', [{ value: 'a', label: 'Deaths' }]);
    });
    expect(await screen.findByText('choices: Deaths')).toBeTruthy();
  });
});
