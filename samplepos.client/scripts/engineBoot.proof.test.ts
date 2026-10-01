import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import {
  PAGE_ENGINE_PROBE_SOURCE,
  decideEngine,
  engineBootScript,
  selectPageEngine,
} from './engineBoot.mjs';

describe('page engine selection', () => {
  it('uses the modern script when the probe returns 1', () => {
    expect(selectPageEngine(() => 1)).toBe('modern');
  });

  it('uses the Chrome 62 script when the probe throws', () => {
    expect(
      selectPageEngine(() => {
        throw new SyntaxError('Unexpected token .');
      }),
    ).toBe('legacy');
  });

  it('the address can force either script before publish', () => {
    expect(decideEngine('?engine=legacy', () => 1)).toBe('legacy');
    expect(decideEngine('?engine=modern', () => {
      throw new SyntaxError('Unexpected token .');
    })).toBe('modern');
    expect(decideEngine('', () => 1)).toBe('modern');
  });

  it('this Node compiles the same probe a current browser would', () => {
    expect(selectPageEngine(new Function(PAGE_ENGINE_PROBE_SOURCE))).toBe('modern');
  });

  it('the boot script itself is ES5 and names both outputs', () => {
    const boot = engineBootScript({
      modernJs: '/assets/index-modern.js',
      legacyJs: '/assets/legacy-index-old.js',
      modernCss: '/assets/index-modern.css',
      legacyCss: '/assets/legacy-index-old.css',
    });
    expect(() => parse(boot, { ecmaVersion: 5 })).not.toThrow();
    expect(boot).toContain('SMART_ERP_ENGINE');
    expect(boot).toContain('SMART_ERP_MODULE_LOADED');
    expect(boot).toContain('/assets/index-modern.js');
    expect(boot).toContain('/assets/legacy-index-old.js');
  });
});
