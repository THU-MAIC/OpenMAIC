export function buildInterviewWhiteboardNotes(answer: string) {
  const trimmed = answer.length > 180 ? `${answer.slice(0, 177)}...` : answer;
  return [
    'Key answer points',
    trimmed,
  ];
}
