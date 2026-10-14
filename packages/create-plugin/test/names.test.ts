import { describe, expect, it } from 'vitest';
import { RESERVED_IDS as CORE_RESERVED_IDS } from '@petalbot/core';
import { RESERVED_IDS, member, namesOf } from '../src/names.ts';

describe('namesOf', () => {
  it('derives a variable name and a title from the id', () => {
    expect(namesOf('quotes')).toEqual({ id: 'quotes', camel: 'quotes', title: 'Quotes' });
    expect(namesOf('my-cool-plugin')).toEqual({
      id: 'my-cool-plugin',
      camel: 'myCoolPlugin',
      title: 'My cool plugin',
    });
    expect(namesOf('x2-go')).toEqual({ id: 'x2-go', camel: 'x2Go', title: 'X2 go' });
  });
});

describe('member', () => {
  it('uses dot access for identifiers and brackets otherwise', () => {
    expect(member('api', 'quotes')).toBe('api.quotes');
    expect(member('api', 'my-plugin')).toBe("api['my-plugin']");
  });
});

it('reserves the same ids as the core', () => {
  expect(RESERVED_IDS).toEqual(CORE_RESERVED_IDS);
});
