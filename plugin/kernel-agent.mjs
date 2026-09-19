import {nativeImport} from './page-native.mjs';
const {scopeOf}=await nativeImport('@deepseek-ai/dsh-scope');
export const name='coldx-kernel-scope';
export const inject=['coldxKernel'];
export function apply(ctx){const scope=scopeOf(ctx);if(scope)ctx.effect(()=>ctx.coldxKernel.attach(scope));}
