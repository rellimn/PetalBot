import { createPluginClient } from '@petalbot/ui-sdk';
import { counterContract } from './contract.ts';

/** The counter's typed panel client (module scope, as the React Compiler requires). */
export const counter = createPluginClient(counterContract);
