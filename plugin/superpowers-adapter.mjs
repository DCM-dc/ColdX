import {dshRequire} from './page-native.mjs';
const {parse}=dshRequire('yaml');
const NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Keep upstream prose intact; platform-specific guidance is a separate suffix. */
export function parseSuperpowersSkill(source,path) {
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if(!match)throw Error(`Missing skill frontmatter: ${path}`);
  const data=parse(match[1]);
  if(!data||!NAME.test(data.name)||typeof data.description!=='string'||!data.description.trim())throw Error(`Invalid skill metadata: ${path}`);
  return {name:data.name,description:data.description.slice(0,1000),content:match[2].trim(),path,
    invocation:{modelInvocable:data['disable-model-invocation']!==true,userInvocable:data['user-invocable']!==false}};
}

export const SUPERPOWERS_DSH_GUIDANCE=`ColdX / native DSH adaptation: use the native skill tool for a named skill, and load only its referenced resources when needed. Use the actual available todo_write, subagent, file and shell tools; do not invent another harness's APIs. The user's explicit instructions and already-granted authorization take precedence over skill ceremony. Native Plan mode remains authoritative: submit its plan for review before implementation. Optional visual-companion launchers are not supplied by this Markdown-only distribution; use ColdX's native inline pages if a visual is useful. A subagent should follow its bounded assignment instead of restarting the entire planning workflow. Treat upstream examples as examples, not commands to execute automatically.`;

/** Called by the existing ColdX policy section; never adds a second system prompt. */
export function superpowersPrompt(context) {
  const agent=context?.agent;
  const service=agent?.ctx?.get?.('coldxSuperpowers');
  if(!service?.enabledFor?.(agent))return '';
  return '\n\nSuperpowers is enabled for this profile. Before acting on a coding task, select relevant skills from the native skill catalog and load their instructions with skill(name). Keep the scope proportional to the request; avoid loading unrelated skills. '+SUPERPOWERS_DSH_GUIDANCE;
}
