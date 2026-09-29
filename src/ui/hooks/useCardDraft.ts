import { useState, type Dispatch, type SetStateAction } from 'react';

/** In-memory values owned by the card. Back preserves them; closing drops them. */
export type CardDraft = Record<string, unknown>;
export function useCardDraft<T extends string | boolean>(
  draft: CardDraft | undefined, key: string, initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => draft?.[key] as T ?? (typeof initial === 'function' ? initial() : initial));
  return [value, next => setValue(previous => {
    const resolved = typeof next === 'function' ? next(previous) : next;
    if (draft) draft[key] = resolved;
    return resolved;
  })];
}
