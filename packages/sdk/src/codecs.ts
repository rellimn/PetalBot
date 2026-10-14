import { z } from 'zod';

/**
 * Codecs for values JSON cannot carry. Use them in event payloads and RPC outputs that reach the
 * browser: the server encodes them for the wire and the browser client decodes them back, so both
 * ends work with the real type. Write your own with `z.codec(wire, value, { decode, encode })`.
 */
export const codecs = {
  /** A `Date` in code, an ISO 8601 string on the wire. */
  isoDate: () =>
    z.codec(z.iso.datetime({ offset: true }), z.date(), {
      decode: (text) => new Date(text),
      encode: (date) => date.toISOString(),
    }),
  /** A `bigint` in code, a decimal string on the wire. */
  bigintString: () =>
    z.codec(z.string().regex(/^-?\d+$/), z.bigint(), {
      decode: (text) => BigInt(text),
      encode: (value) => value.toString(),
    }),
};
