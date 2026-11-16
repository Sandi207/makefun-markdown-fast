import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse} from './parse.js';

const inputDirectory = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDirectory, 'cases.json'), 'utf8'));
const html = cases.map((entry) => parse(entry.markdown));
mkdirSync(outputDirectory, {recursive: true});
writeFileSync(join(outputDirectory, 'html.json'), JSON.stringify(html));
