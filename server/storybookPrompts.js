export const STORYBOOK_PAGES = [
  { promptId: 'meet', title: 'Meet the hero', prompt: 'Who is our hero, and what do they love?' },
  { promptId: 'problem', title: 'A surprise!', prompt: 'Something unexpected changes their day.' },
  { promptId: 'try', title: 'The big idea', prompt: 'What do they try, and who helps them?' },
  { promptId: 'ending', title: 'The ending', prompt: 'Show how everything ends in a surprising way.' },
];

export function defaultStorybook(scenes = []) {
  return {
    enabled: true,
    title: 'Our Story',
    pages: STORYBOOK_PAGES.map((page, index) => ({
      sceneId: scenes[index]?.id || `s${index}`,
      promptId: page.promptId,
      caption: '',
      locked: false,
    })),
  };
}

export function storybookPrompt(promptId) {
  return STORYBOOK_PAGES.find((page) => page.promptId === promptId) || STORYBOOK_PAGES[0];
}
