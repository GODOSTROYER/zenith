import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { assertUxAcceptance } from './ux-receipt.mjs';

const enabled = process.env.ZENITH_TEST_UX01_RECEIPT === '1';
const gated = describe.skipIf(!enabled);

function privateReceipt(name: string): unknown {
  try {
    const value = process.env[name];
    if (!value || !path.isAbsolute(value) || typeof process.getuid !== 'function') throw new Error('ux01:private-receipt-required');
    const file = path.resolve(value);
    const relative = path.relative(path.resolve(process.cwd()), file);
    if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('ux01:private-receipt-required');
    const parent = fs.lstatSync(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 ||
        !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('ux01:private-receipt-required');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw new Error('ux01:private-receipt-required'); }
}

gated('PROD-UX-01 actual-browser receipt', () => {
  it('validates the source-bound actual-browser receipt against the completed J2 receipt', () => {
    assertUxAcceptance(privateReceipt('ZENITH_UX01_RECEIPT'), privateReceipt('ZENITH_JOURNEY_RECEIPT'));
  });
});
