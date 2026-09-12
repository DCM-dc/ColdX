import { nativeImport } from './page-native.mjs';
import { CODING_MODE_EVENT, codingModeProjection } from './coding-mode-model.mjs';

const { KNOWN_SESSION_EVENT_TYPES } = await nativeImport('@deepseek-ai/dsh-session');

export const name = 'coldx-coding-mode-persistence';

/**
 * Host-lifetime compatibility for ColdX's legacy preference event. Pinned DSH
 * has no downstream event-registration service, so register the one exact type
 * this plugin validates before any browser history inspection or Agent resume.
 */
export function apply(ctx) {
  KNOWN_SESSION_EVENT_TYPES.add(CODING_MODE_EVENT);
  ctx.inject(['sessionProjections'], projected => projected.sessionProjections.register(codingModeProjection));
}
