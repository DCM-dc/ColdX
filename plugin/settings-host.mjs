import { nativeImport } from './page-native.mjs';

const { settingsNamespace } = await nativeImport('@deepseek-ai/dsh-settings');
const { default: Schema } = await nativeImport('@deepseek-ai/schemastery');

export const name = 'coldx-settings';
export const inject = ['settings'];
export const COLDX_SETTINGS_NAMESPACE = settingsNamespace('coldx-activity');
export const COLDX_SETTINGS_BASE = Object.freeze({ showTerminal: false });
export const coldxSettingsSchema = Schema.object({ showTerminal: Schema.boolean().default(false) });

/** Register once in the Host plane; this module is not mounted per Agent. */
export function apply(ctx) {
  ctx.settings.register(COLDX_SETTINGS_NAMESPACE, coldxSettingsSchema, {
    base: COLDX_SETTINGS_BASE,
    applies: 'live',
  });
}
