export const AI_COLORING_CONSENT_VERSION = 'family-page-2026-11-21';
export const MAX_COLORING_PROMPT = 300;

export const COLORING_DETAILS = [
  { id: 'simple', label: 'Big shapes' },
  { id: 'detailed', label: 'More detail' },
];

export const COLORING_IDEAS = [
  'A sleepy dragon curled up inside a teacup garden',
  'Two otters delivering postcards in a little rowboat',
  'A robot tending a greenhouse on the moon',
  'A bakery inside a tree where forest animals meet',
];

export function getColoringRecipe(input) {
  if (!input || typeof input.prompt !== 'string' || input.prompt.length > MAX_COLORING_PROMPT) return null;
  const prompt = input.prompt.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const detail = input.detail === undefined ? 'simple' : input.detail;
  if (!prompt || prompt.length > MAX_COLORING_PROMPT || !COLORING_DETAILS.some(choice => choice.id === detail)) return null;
  return { title: 'Custom coloring page', prompt, detail };
}
