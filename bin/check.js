#!/usr/bin/env node
// Usage: node bin/check.js <name> [more names] [--tlds com,io,ai] [--platforms x,instagram] [--tm US,EU] [--variations 3] [--json]
import { checkNames, renderReport } from '../src/index.js';
import { whoisNode } from '../src/whois-node.js';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const json = args.includes('--json');
if (json) args.splice(args.indexOf('--json'), 1);
const tlds = opt('tlds')?.split(',');
const platforms = opt('platforms')?.split(',');
const trademarkCountries = opt('tm')?.split(',');
const variations = opt('variations');
const names = args;
if (!names.length) {
  console.error('usage: node bin/check.js <name> [...] [--tlds com,io] [--platforms x,github] [--tm US] [--variations 3] [--json]');
  process.exit(2);
}
const res = await checkNames({ names, tlds, platforms, trademarkCountries, variations: variations ? Number(variations) : 0 }, { whois: whoisNode });
console.log(json ? JSON.stringify(res, null, 2) : renderReport(res));
