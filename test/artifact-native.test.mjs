import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeRuntime, nativeImport } from './native-helpers.mjs';
import * as artifactHost from '../plugin/artifact-host.mjs';
import { selectActivityOutputs } from '../plugin/client/activity-source.mjs';
test('an actual shell-created file registers as an openable artifact without returning file content', async t => {
  const root = await mkdtemp(join(tmpdir(),'coldx-artifact-'));
  await writeFile(join(root,'report.md'),'# Private file body');
  const ctx = await nativeRuntime(); t.after(()=>ctx.fiber.dispose());
  for (const name of ['dsh-session','dsh-agent','dsh-llm','dsh-agent-loop']) { const module = await nativeImport(`@deepseek-ai/${name}`); await ctx.plugin(module.default ?? module,{}); }
  const {agent} = await ctx.agents.create({sessionId:'session-artifact-test',meta:{cwd:root}});
  await agent.ctx.plugin(artifactHost);
  const call = async path => ctx.tools.execute({agent,callId:'artifact-call',name:'coldx_register_artifact',arguments:{path},signal:new AbortController().signal});
  const result = await call(join(root,'report.md'));
  assert.equal(result.isError,false);
  assert.equal(result.value.path,'report.md');
  assert.equal(result.value.bytes,19);
  assert.equal(JSON.stringify(result).includes('Private file body'),false);
  assert.equal((await call('../outside.md')).isError,true);
  assert.equal((await call('missing.md')).isError,true);
  const view = ctx.tools.get('coldx_register_artifact',agent).presentCall({path:'report.md'});
  const outputs = selectActivityOutputs({sessionId:agent.id,chatNodes:[{kind:'tool-call',data:{root:{kind:'tool-result',callId:'artifact-call',call:{name:'coldx_register_artifact'},callView:view,isError:false}}}]});
  assert.equal(outputs[0].path,'report.md'); assert.equal(outputs[0].statusLabel,'已登记');
});
