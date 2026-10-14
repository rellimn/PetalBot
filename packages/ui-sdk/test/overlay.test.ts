import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineContract } from '@petalbot/sdk';
import { checkOverlayDefinition, defineOverlay } from '../src/overlay.ts';

const alerts = defineContract({
  id: 'alerts',
  version: '1.0.0',
  overlays: {
    box: { config: z.object({ durationMs: z.number().default(5000) }), events: [], rpc: [] },
  },
});

function Box() {
  return null;
}

describe('defineOverlay', () => {
  it('describes the overlay for the host, with its config schema', () => {
    const definition = defineOverlay(alerts, 'box', { component: Box });
    expect(definition).toMatchObject({
      kind: 'petalbot.overlay',
      pluginId: 'alerts',
      name: 'box',
      component: Box,
    });
    expect(definition.config.parse({})).toEqual({ durationMs: 5000 });
  });

  it('refuses names the contract does not declare', () => {
    expect(() => defineOverlay(alerts, 'nope' as never, { component: Box })).toThrow(
      'Contract "alerts" declares no overlay "nope"',
    );
  });
});

describe('checkOverlayDefinition', () => {
  const definition = defineOverlay(alerts, 'box', { component: Box });

  it('accepts the matching definition', () => {
    expect(checkOverlayDefinition(definition, 'alerts', 'box')).toBe(definition);
  });

  it('explains what is wrong with anything else', () => {
    expect(() => checkOverlayDefinition({}, 'alerts', 'box')).toThrow(
      'must default-export defineOverlay',
    );
    expect(() => checkOverlayDefinition(definition, 'alerts', 'ticker')).toThrow(
      'is "alerts/box", not "alerts/ticker"',
    );
    expect(() =>
      checkOverlayDefinition({ ...definition, component: 'nope' }, 'alerts', 'box'),
    ).toThrow('has no component');
    expect(() => checkOverlayDefinition({ ...definition, config: {} }, 'alerts', 'box')).toThrow(
      'has no config schema',
    );
  });
});
