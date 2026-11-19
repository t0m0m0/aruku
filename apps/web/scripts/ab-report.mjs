import { readFileSync } from 'node:fs';

import { abReport } from '../src/bench/ab-report.ts';

const args = process.argv.slice(2);
const recordsPath = args.at(0);
const verifyPath = args.at(1);
if (recordsPath === undefined) {
  console.error('usage: node scripts/ab-report.mjs <records.jsonl> [verify.jsonl]');
  process.exit(2);
}

/**
 * @param {string} line
 * @returns {unknown}
 */
const parseLine = (line) => JSON.parse(line);

/** @param {string} path */
const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseLine);

process.stdout.write(
  abReport(readJsonl(recordsPath), verifyPath === undefined ? [] : readJsonl(verifyPath)),
);
