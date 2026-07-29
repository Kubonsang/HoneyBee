/** Monaco-neutral keybinding groups for the Honey Bee Prompt Editor. */
export interface PromptKeyBindings {
  readonly submit: readonly number[];
  readonly newline: readonly number[];
}

/** Builds the fixed Enter modifier policy from Monaco key constants. */
export const createPromptKeyBindings = (
  enter: number,
  controlOrCommand: number,
  shift: number,
  alt: number,
): PromptKeyBindings => ({
  submit: [enter, controlOrCommand | enter],
  newline: [shift | enter, alt | enter],
});

/** Determines whether content may enter the Prompt delivery protocol. */
export const shouldSubmitPrompt = (
  content: string,
  isComposing: boolean,
  isPending: boolean,
): boolean => content.trim().length > 0 && !isComposing && !isPending;
