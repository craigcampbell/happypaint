export async function fetchDrawingPrompts(token, signal) {
  const response = await fetch('/api/drawing-prompts', {
    signal,
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const error = new Error('Could not load drawing prompts');
    error.status = response.status;
    throw error;
  }
  const { prompts } = await response.json();
  if (!Array.isArray(prompts) || !prompts.length || !prompts.every(
    (prompt) => typeof prompt?.id === 'string' && typeof prompt.text === 'string' && prompt.text.length > 0,
  )) throw new Error('Invalid drawing prompts');
  return prompts;
}

export function drawingIdeaPath(id, signUp = false) {
  const path = `/draw?idea=${encodeURIComponent(id)}`;
  return signUp ? `/signup?return=${encodeURIComponent(path)}` : path;
}
