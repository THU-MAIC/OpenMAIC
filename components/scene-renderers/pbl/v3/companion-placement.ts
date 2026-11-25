export const COMPANION_SIZE = 76;
export const COMPANION_RIGHT = 40;
export const CONVERSATION_MIN_HEIGHT = 360;

// Leave the application's bottom controls exposed, but keep room above for the role's cards.
export function companionHomeBottom(height: number) {
  return Math.min(160, Math.round(height / 3));
}

export function initialConversationWindow({ width, height }: { width: number; height: number }) {
  const inset = 16;
  const bottom = companionHomeBottom(height);
  const w = Math.min(440, width - 2 * inset);
  const avatarSpace = COMPANION_RIGHT + COMPANION_SIZE + inset;
  const aboveAvatar = bottom + COMPANION_SIZE + 12;
  // A short workbench can fit a full conversation beside the avatar instead of over it.
  const beside =
    height - aboveAvatar - inset < CONVERSATION_MIN_HEIGHT && width >= w + avatarSpace + inset;
  const clearance = beside ? bottom : aboveAvatar;
  const h = Math.min(620, Math.max(CONVERSATION_MIN_HEIGHT, height - clearance - inset));
  return {
    x: width - w - (beside ? avatarSpace : inset),
    y: Math.max(0, height - clearance - h),
    width: w,
    height: h,
  };
}
