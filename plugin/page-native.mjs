import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(import.meta.url);
export const dshRequire = createRequire(realpathSync(localRequire.resolve('@deepseek-ai/dsh/package.json')));
export const nativeImport = name => import(pathToFileURL(dshRequire.resolve(name)).href);
