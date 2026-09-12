import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Resolve the dependency graph owned by the pinned DSH CLI, including pnpm's
// transitive package layout. This never falls back to another installation.
const dshRequire = createRequire(realpathSync(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)));
export const nativeImport = name => import(pathToFileURL(dshRequire.resolve(name)).href);

export async function nativeRuntime() {
  const { Context } = await nativeImport('@deepseek-ai/cordis');
  const { default: Prompt } = await nativeImport('@deepseek-ai/dsh-system-prompt');
  const { default: Tools } = await nativeImport('@deepseek-ai/dsh-tools');
  const { default: Runner } = await nativeImport('@deepseek-ai/dsh-cordis-host-runner');
  const cordisTools = await nativeImport('@deepseek-ai/dsh-tool-cordis');
  const ctx = new Context();
  await ctx.plugin(Prompt, {});
  await ctx.plugin(Tools, {});
  await ctx.plugin(Runner, {});
  await ctx.plugin(cordisTools);
  return ctx;
}
