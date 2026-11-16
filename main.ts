import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type MarkdownCase = { id: string; markdown: string };

const inputDirectory = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const inputPath = join(inputDirectory, 'cases.json');
const cases: MarkdownCase[] = JSON.parse(readFileSync(inputPath, 'utf8'));
if (!Array.isArray(cases)) throw new TypeError(inputPath + ' must contain an array');

const rendered = new Array<string>(cases.length);
for (let index = 0; index < cases.length; index++) {
  const entry = cases[index];
  if (entry === null || typeof entry !== 'object' || typeof entry.markdown !== 'string') {
    throw new TypeError('Invalid markdown in case ' + index + ' of ' + inputPath);
  }
  rendered[index] = parse(entry.markdown);
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'html.json'), JSON.stringify(rendered), 'utf8');
