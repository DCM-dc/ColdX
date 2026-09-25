import {mkdir,readFile,rename,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {recoverTeams} from './state.mjs';
// 8 teams × 80 messages × (2,000 text + bounded identifiers/names) code
// units, at up to six JSON bytes per escaped unit, plus member metadata.
// Leave bounded overhead and enforce the same byte ceiling on both paths.
export const MAX_STORE_BYTES=16*1024*1024;
export const MAX_IGNORED_SESSIONS=64;
export const MAX_IGNORED_TURNS=512;
function recoverIgnoredTurns(value){
 if(!Array.isArray(value))return [];
 const records=new Map();
 for(const record of value.slice(-MAX_IGNORED_SESSIONS)){
  if(typeof record?.sessionId!=='string'||!record.sessionId.trim()||record.sessionId.length>200||!Number.isSafeInteger(record.createdAt)||record.createdAt<0||!Array.isArray(record.turns))continue;
  const turns=[...new Set(record.turns.slice(-MAX_IGNORED_TURNS*2).filter(turn=>Number.isSafeInteger(turn)&&turn>0))].sort((a,b)=>a-b).slice(-MAX_IGNORED_TURNS);
  if(turns.length)records.set(record.sessionId,{sessionId:record.sessionId,createdAt:record.createdAt,turns});
 }
 return [...records.values()];
}
export class TeamStore{
 constructor(profileDir){this.path=profileDir?join(profileDir,'companion-teams.json'):undefined;this.tail=Promise.resolve();this.ignoredTurns=[];}
 async load(){if(!this.path)return [];try{if((await stat(this.path)).size>MAX_STORE_BYTES)throw Error('Companion team store exceeds limit.');const value=JSON.parse(await readFile(this.path,'utf8'));this.ignoredTurns=recoverIgnoredTurns(value.ignoredTurns);return recoverTeams(value.teams);}catch(error){if(error.code==='ENOENT')return [];throw Error('无法读取团队记录；请检查 companion-teams.json。',{cause:error});}}
 save(teams){if(!this.path)return Promise.resolve();const data=JSON.stringify({version:1,teams,ignoredTurns:recoverIgnoredTurns(this.ignoredTurns)});if(Buffer.byteLength(data,'utf8')>MAX_STORE_BYTES)return Promise.reject(Error('Companion team store exceeds limit.'));const operation=this.tail.then(async()=>{await mkdir(join(this.path,'..'),{recursive:true});await writeFile(this.path+'.tmp',data,{encoding:'utf8',mode:0o600});await rename(this.path+'.tmp',this.path);});this.tail=operation.catch(()=>{});return operation;}
}
