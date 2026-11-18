import { describe, expect, it } from 'vitest';
import { splitSpeechSentences } from '@/lib/audio/browser-speech-text';

describe('splitSpeechSentences', () => {
  it('splits after sentence punctuation followed by whitespace', () => {
    expect(splitSpeechSentences('First one. Second one! Third one?')).toEqual([
      'First one.',
      'Second one!',
      'Third one?',
    ]);
  });

  it('keeps decimals, versions and domains in one sentence', () => {
    expect(splitSpeechSentences('Pi is about 3.14 here.')).toEqual(['Pi is about 3.14 here.']);
    expect(splitSpeechSentences('Version 1.5.0 is out. Upgrade now!')).toEqual([
      'Version 1.5.0 is out.',
      'Upgrade now!',
    ]);
    expect(splitSpeechSentences('Visit example.org today.')).toEqual(['Visit example.org today.']);
    expect(splitSpeechSentences('Open https://example.com/a?b=1 now.')).toEqual([
      'Open https://example.com/a?b=1 now.',
    ]);
  });

  it('does not split after an abbreviation followed by a lowercase word', () => {
    expect(splitSpeechSentences('Use a tool, e.g. a ruler. Then measure.')).toEqual([
      'Use a tool, e.g. a ruler.',
      'Then measure.',
    ]);
    expect(splitSpeechSentences('Plants, i.e. producers, make sugar.')).toEqual([
      'Plants, i.e. producers, make sugar.',
    ]);
  });

  it('does not split after a title, e.g. or i.e., or leave a lone initial on its own', () => {
    expect(splitSpeechSentences('Try a language, e.g. Python. It is easy.')).toEqual([
      'Try a language, e.g. Python.',
      'It is easy.',
    ]);
    expect(splitSpeechSentences('Ask Dr. Smith and Mrs. Jones. They know.')).toEqual([
      'Ask Dr. Smith and Mrs. Jones.',
      'They know.',
    ]);
    expect(splitSpeechSentences('J. K. Rowling wrote it. Then it sold.')).toEqual([
      'J. K. Rowling wrote it.',
      'Then it sold.',
    ]);
  });

  it('does not split a reference abbreviation from its number', () => {
    expect(splitSpeechSentences('See Fig. 2 for details. Read Ch. 3 next.')).toEqual([
      'See Fig. 2 for details.',
      'Read Ch. 3 next.',
    ]);
    expect(splitSpeechSentences('Solve Eq. 4 on p. 12. Then rest.')).toEqual([
      'Solve Eq. 4 on p. 12.',
      'Then rest.',
    ]);
    expect(splitSpeechSentences('It was the year 1999. 2000 came next.')).toEqual([
      'It was the year 1999.',
      '2000 came next.',
    ]);
  });

  it('splits after an abbreviation or letter that can end a sentence', () => {
    expect(splitSpeechSentences('Choose plan A. Next, confirm it.')).toEqual([
      'Choose plan A.',
      'Next, confirm it.',
    ]);
    expect(splitSpeechSentences('Select Option A. Next, confirm it.')).toEqual([
      'Select Option A.',
      'Next, confirm it.',
    ]);
    expect(splitSpeechSentences('Take Vitamin D. It is important.')).toEqual([
      'Take Vitamin D.',
      'It is important.',
    ]);
    expect(splitSpeechSentences('That is all, etc. Next topic.')).toEqual([
      'That is all, etc.',
      'Next topic.',
    ]);
    expect(splitSpeechSentences('Acme Inc. Customers approved it.')).toEqual([
      'Acme Inc.',
      'Customers approved it.',
    ]);
    // These can end a sentence too, so before a capitalized word they are
    // treated as one: an extra pause costs less than merging two sentences.
    expect(splitSpeechSentences('The U.S. Army left.')).toEqual(['The U.S.', 'Army left.']);
    expect(splitSpeechSentences('John F. Kennedy spoke.')).toEqual(['John F.', 'Kennedy spoke.']);
    expect(splitSpeechSentences('I like it. Then I left.')).toEqual(['I like it.', 'Then I left.']);
  });

  it('always splits after ! and ? before whitespace, even before a lowercase word', () => {
    expect(splitSpeechSentences('What is npm? npm is a package manager.')).toEqual([
      'What is npm?',
      'npm is a package manager.',
    ]);
    expect(splitSpeechSentences('Ready? iOS will open!')).toEqual(['Ready?', 'iOS will open!']);
    expect(splitSpeechSentences('Wait... and then it stopped.')).toEqual([
      'Wait... and then it stopped.',
    ]);
    expect(splitSpeechSentences('"Why?" she asked. Then she left.')).toEqual([
      '"Why?" she asked.',
      'Then she left.',
    ]);
  });

  it('keeps an ellipsis and repeated punctuation with their sentence', () => {
    expect(splitSpeechSentences('Wait... What happened?!')).toEqual(['Wait...', 'What happened?!']);
    expect(splitSpeechSentences('Wait...')).toEqual(['Wait...']);
    expect(splitSpeechSentences('Really ? ! Yes.')).toEqual(['Really ? !', 'Yes.']);
  });

  it('splits Chinese after its sentence punctuation, keeping runs and closing quotes together', () => {
    expect(splitSpeechSentences('光合作用很重要。它发生在叶绿体中。')).toEqual([
      '光合作用很重要。',
      '它发生在叶绿体中。',
    ]);
    expect(splitSpeechSentences('真的吗？！太好了。')).toEqual(['真的吗？！', '太好了。']);
    expect(splitSpeechSentences('他说：“好的。”然后走了。')).toEqual([
      '他说：“好的。”',
      '然后走了。',
    ]);
  });

  it('keeps closing quotes and brackets with the sentence they end', () => {
    expect(splitSpeechSentences('He said "Stop." Then he left.')).toEqual([
      'He said "Stop."',
      'Then he left.',
    ]);
    expect(splitSpeechSentences('Il a dit \u00AB Arr\u00EAte. \u00BB Puis il partit.')).toEqual([
      'Il a dit \u00AB Arr\u00EAte. \u00BB',
      'Puis il partit.',
    ]);
    expect(splitSpeechSentences('Il a dit \u00ABArr\u00EAte.\u00BB Puis il partit.')).toEqual([
      'Il a dit \u00ABArr\u00EAte.\u00BB',
      'Puis il partit.',
    ]);
    expect(splitSpeechSentences('(See the chart.) Next part.')).toEqual([
      '(See the chart.)',
      'Next part.',
    ]);
  });

  it('splits on newlines and mixed-language text', () => {
    expect(splitSpeechSentences('Line one\nLine two')).toEqual(['Line one', 'Line two']);
    expect(splitSpeechSentences('B.\nNext question.')).toEqual(['B.', 'Next question.']);
    expect(splitSpeechSentences('Hello\n?!')).toEqual(['Hello', '?!']);
    expect(splitSpeechSentences('Hello\n... world')).toEqual(['Hello', '... world']);
    expect(splitSpeechSentences('A.\nB. C. Smith wrote it.')).toEqual([
      'A.',
      'B. C. Smith wrote it.',
    ]);
    expect(splitSpeechSentences('Guten Morgen. 你好，这是第二句。 Third.')).toEqual([
      'Guten Morgen.',
      '你好，这是第二句。',
      'Third.',
    ]);
  });

  it('handles text without sentence punctuation, blank text and punctuation alone', () => {
    expect(splitSpeechSentences('No punctuation here')).toEqual(['No punctuation here']);
    expect(splitSpeechSentences('  \n ')).toEqual([]);
    expect(splitSpeechSentences('?!')).toEqual(['?!']);
    expect(splitSpeechSentences('. Hello there.')).toEqual(['. Hello there.']);
    expect(splitSpeechSentences('Bye. J. ?!')).toEqual(['Bye.', 'J. ?!']);
    expect(splitSpeechSentences('Bye. J.')).toEqual(['Bye.', 'J.']);
  });
});
