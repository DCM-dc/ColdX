import { normalizePageInput } from './page-input.mjs';

function string(value, name, limit, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${name} must be a string of at most ${limit} characters.`);
  return value.trim();
}
function boolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

export function normalizeInteractionInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Interaction arguments must be an object.');
  const title = string(args.title, 'title', 200);
  const question = string(args.question, 'question', 4_000);
  if (!title || !question) throw new Error('Interaction title and question must not be blank.');
  const multiSelect = boolean(args.multiSelect, 'multiSelect', false);
  const allowCustom = boolean(args.allowCustom, 'allowCustom', true);
  const submitLabel = string(args.submitLabel, 'submitLabel', 80, '确认并继续');
  const raw = args.options ?? [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('options must be an array of at most 20 choices.');
  if (!raw.length && !allowCustom) throw new Error('An interaction without options must allow custom input.');
  const ids = new Set();
  const labels = new Set();
  let recommendations = 0;
  const options = raw.map(option => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Each option must be an object.');
    const id = string(option.id, 'option.id', 120);
    const label = string(option.label, 'option.label', 200);
    const description = string(option.description, 'option.description', 1_000, '');
    const recommended = boolean(option.recommended, 'option.recommended', false);
    if (recommended && ++recommendations > 1) throw new Error('At most one option may be recommended.');
    if (!id || !label || ids.has(id) || labels.has(label)) throw new Error('Option IDs and labels must be non-empty and unique.');
    ids.add(id); labels.add(label);
    let preview;
    if (option.preview !== undefined) {
      if (!option.preview || typeof option.preview !== 'object' || Array.isArray(option.preview)) throw new Error('option.preview must be a page-source object.');
      const { html, css, script } = normalizePageInput({ ...option.preview, title: label, waitForInput: false });
      preview = { html, css, script };
    }
    return { id, label, description, recommended, ...(preview ? { preview } : {}) };
  });
  return { title, question, options, multiSelect, allowCustom, submitLabel: submitLabel || '确认并继续' };
}

/** Validate the same labels/IDs the native question carrier presented. */
export function normalizeInteractionAnswer(input, questionId, answer) {
  const items = answer?.answers;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.id !== questionId) throw new Error('Answer must address this exact interaction question.');
  const item = items[0];
  if (!Array.isArray(item.selected) || item.selected.some(label => typeof label !== 'string')) throw new Error('Selected answers must be option labels.');
  const selectedLabels = [...item.selected];
  const byLabel = new Map(input.options.map(option => [option.label, option.id]));
  if (new Set(selectedLabels).size !== selectedLabels.length || selectedLabels.some(label => !byLabel.has(label))) throw new Error('Selected labels must be unique choices from this interaction.');
  const custom = string(item.custom, 'custom', 8_000, '');
  if (custom && !input.allowCustom) throw new Error('This interaction does not accept custom input.');
  if (!input.multiSelect && (selectedLabels.length > 1 || selectedLabels.length && custom)) throw new Error('Choose one option or custom input for a single-select interaction.');
  if (!selectedLabels.length && !custom) throw new Error('Choose an option or enter a custom answer before submitting.');
  return { selectedIds: selectedLabels.map(label => byLabel.get(label)), selectedLabels, custom };
}

export function normalizeCompletionInput(args) {
  const summary = string(args?.summary, 'summary', 12_000);
  if (!summary) throw new Error('Completion summary must not be blank.');
  return { summary };
}
