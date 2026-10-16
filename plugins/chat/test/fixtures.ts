/**
 * Test data and helper plugins for the chat tests: a viewer, messages, a connection, a second
 * platform plugin and a `chat.beforeSend` tap, all started inside the harness's kernel.
 */
import {
  defineContract,
  definePlugin,
  type HookHandler,
  type LogData,
  type Logger,
  type PluginContext,
} from '@petalbot/sdk';
import type { TestHarness } from '@petalbot/testing';
import { chatContract, type ChatMessage, type ChatUser } from '../src/contract.ts';

export const viewer: ChatUser = {
  id: 'u1',
  login: 'viewer',
  displayName: 'Viewer',
  badges: { broadcaster: false, moderator: false, vip: false, subscriber: true },
};

export const twitch = {
  id: 'twitch:roman',
  platform: 'twitch',
  channel: 'roman',
  displayName: 'roman',
  isDefault: true,
};

export function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    source: { platform: 'twitch', connection: 'twitch:roman' },
    user: viewer,
    text: `message ${id}`,
    timestamp: 1_000,
    fromBot: false,
    ...overrides,
  };
}

type ChatHarness = TestHarness<typeof chatContract, [], []>;
type DependentContext = PluginContext<{ id: string; version: string }, [typeof chatContract], []>;

/** Starts a plugin `id` that depends on chat, and hands out its ctx. */
async function startDependent(
  harness: ChatHarness,
  id: string,
  setup: (ctx: DependentContext) => void = () => undefined,
): Promise<DependentContext> {
  const holder: { ctx?: DependentContext } = {};
  await harness.kernel.start(
    definePlugin(defineContract({ id, version: '1.0.0' }), {
      dependencies: [chatContract],
      setup(ctx) {
        holder.ctx = ctx;
        setup(ctx);
      },
    }),
  );
  if (!holder.ctx) throw new Error(`${id} did not start`);
  return holder.ctx;
}

/** A second platform plugin: it provides `key` with a working `send`. */
export function startPlatform(harness: ChatHarness, id: string, key: string) {
  return startDependent(harness, id, (ctx) => {
    ctx.provide('chat.platform', key, {
      send: () => Promise.resolve({ ok: true, messageId: `${id}-1` }),
    });
  });
}

type BeforeSend = HookHandler<typeof chatContract.hooks.beforeSend.input>;

/** A plugin `id` that taps `chat.beforeSend` with `handler`. */
export function startTap(harness: ChatHarness, id: string, handler: BeforeSend) {
  return startDependent(harness, id, (ctx) => {
    ctx.hook('chat.beforeSend', handler);
  });
}

export interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly data: LogData;
}

/** A logger that records what it is told. */
export function recordingLogger(lines: LogLine[] = []): Logger & { readonly lines: LogLine[] } {
  const write =
    (level: string) =>
    (text: string, data: LogData = {}) => {
      lines.push({ level, message: text, data });
    };
  return {
    lines,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => recordingLogger(lines),
  };
}
