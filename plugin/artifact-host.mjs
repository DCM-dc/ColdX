import { nativeImport } from './page-native.mjs';
import { describeWorkspaceFile } from './workspace-files.mjs';
const { defineTool } = await nativeImport('@deepseek-ai/dsh-tools');
export const name = 'coldx-artifacts';
export const inject = ['tools', 'agents'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'coldx_register_artifact',
    description: 'Register a finished file as a user-facing deliverable, including files created by shell/Python or a subagent. Checks that the file exists inside this session workspace, returns its canonical path and size, and makes it openable in ColdX. Call after creating and checking an actual deliverable; never register temporary scripts/logs as final output or use this as proof of content quality. In your answer link to the returned path using Markdown [title](path). Does not change the file or read its body into model context.',
    parameters: { path:{type:'string',required:true,description:'Existing file path, relative to this workspace or an absolute path inside it.'}, title:{type:'string',description:'Short user-facing deliverable title.'} },
    output: { schema:{type:'json'}, render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}] },
    presentCall: args => ({card:'generic',kind:'read',title:`登记产物 · ${args.title || args.path}`,locations:[{path:args.path}]}),
    async execute(args,exec) {
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('Artifact requires its exact live Agent.');
      const cwd = exec.agent.session?.header?.cwd;
      if (typeof cwd !== 'string' || !cwd) throw new Error('Artifact requires an Agent workspace.');
      return {...await describeWorkspaceFile(cwd,{path:args.path},exec.signal),...(args.title ? {title:args.title.slice(0,160)} : {})};
    },
  }));
}
