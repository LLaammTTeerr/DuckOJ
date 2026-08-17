import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/index.js';

const target = fileURLToPath(new URL('../../../openapi.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
