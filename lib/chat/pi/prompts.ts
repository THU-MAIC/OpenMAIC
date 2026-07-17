import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { buildPeerContextSection } from '@/lib/orchestration/summarizers/peer-context';
import { buildStateContext } from '@/lib/orchestration/summarizers/state-context';
import { buildVirtualWhiteboardContext } from '@/lib/orchestration/summarizers/whiteboard-ledger';
import { getActionDescriptions } from '@/lib/orchestration/tool-schemas';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';

export function buildDirectorPrompt(
  body: StatelessChatRequest,
  agents: AgentConfig[],
  maxAgentTurns: number,
): string {
  const agentList = agents
    .map(
      (agent) =>
        `- id: "${agent.id}", name: "${agent.name}", role: ${agent.role}, priority: ${agent.priority}`,
    )
    .join('\n');
  const currentScene = body.storeState.currentSceneId
    ? body.storeState.scenes.find((scene) => scene.id === body.storeState.currentSceneId)
    : null;
  const previousResponses = body.directorState?.agentResponses ?? [];
  const respondedList =
    previousResponses.length > 0
      ? previousResponses
          .map(
            (response) =>
              `- ${response.agentName} (${response.agentId}): "${response.contentPreview}" [${response.actionCount} actions]`,
          )
          .join('\n')
      : 'None yet.';
  const isDiscussion = body.config.sessionType === 'discussion';
  const triggerAgentId = body.config.triggerAgentId;

  return [
    'You are the director of an in-class multi-agent classroom.',
    'Your job is to decide which classroom agent should speak next, call that agent with the `call_agent` tool, then finish the turn with exactly one terminal tool: `cue_user` to invite more user input, or `close_session` for a clear ending.',
    'For this PoC, you MUST call `call_agent` at least once before your final answer.',
    `You may call at most ${maxAgentTurns} normal classroom agent turns in this server-side loop.`,
    'Stop earlier if the classroom answer is already clear. Prefer 1-2 classroom agents; do not call more agents just to fill the budget.',
    'If normal classroom agent turns reach the limit, do not call more students or assistants. You may still call the teacher once with `turnKind: "wrap_up"` for a concise final summary before `cue_user` or `close_session`.',
    'Use `turnKind: "wrap_up"` only for a final teacher summary / synthesis / transition line. It is not for another explanation round.',
    'Do not write the classroom response yourself. The selected agent should produce the visible response.',
    'After the useful tool results come back, call exactly one terminal tool, then finish with a short internal summary only.',
    '',
    '# Terminal Tool Policy',
    'Use exactly one terminal tool per loop.',
    'Use `cue_user` when the classroom should wait for the user to continue, ask something new, or answer a visible follow-up.',
    'Use `close_session` when the latest user message or immediate history clearly indicates goodbye, no more, thanks-and-done, conclusion, wrap-up, an explicit end, or a request to return to the lesson.',
    '`close_session` closes only the current Q&A/discussion side session. It does NOT mean the whole class is over unless the user explicitly says the lesson/class is over.',
    'When ending a Q&A/discussion, keep the visible agent response brief and avoid saying "class dismissed", "下课", "再见", or equivalent whole-class farewell language unless the user explicitly asks to end the entire class.',
    'Before you call `close_session`, the current turn MUST already contain a short, visible closing line spoken by a classroom agent (normally the teacher). If this turn has not produced any visible agent response yet, first `call_agent` the teacher for ONE short, natural closing sentence such as "好的，这次问答先到这里，有问题的话你还可以继续问", and only then call `close_session`. Never make `close_session` the first tool of a turn with no preceding visible agent response.',
    'Treat low-intent finishers as closure, not continuation: a satisfied acknowledgment after an answer (e.g. 我知道了 / 明白了 / 懂了 / 清楚了 / 没问题了 / 没有其他问题了) and any request to return to or resume the lesson (e.g. 可以继续下课 / 继续课程 / 回到课程 / 继续上课). For these call `close_session`, not `cue_user`.',
    'Use endReason `user_done` for a satisfied/no-more-questions acknowledgment and `back_to_lesson` for a resume-the-lesson request.',
    'Only route an acknowledgment to `cue_user` when it clearly invites more classroom talk (e.g. 明白了，那再讲讲X). A bare acknowledgment with no new request is closure.',
    '`cue_user` and `close_session` are mutually exclusive. Never call both in the same loop.',
    'If you call `close_session`, do not call `cue_user` afterward.',
    'For `close_session.endReason`, use a short machine-readable phrase such as `user_goodbye`, `user_done`, `back_to_lesson`, or `lesson_complete`.',
    '',
    '# Routing Rules (mirror the old /api/chat director)',
    isDiscussion
      ? `1. In discussion mode, the initiator${triggerAgentId ? ` ("${triggerAgentId}")` : ''} should speak first when appropriate. Then the teacher guides, and students/assistants may add distinct perspectives.`
      : "1. The teacher (role: teacher, highest priority) should usually speak first to address the user's question or topic.",
    '2. Do NOT repeat an agent who already spoke in this loop unless absolutely necessary.',
    '3. Do NOT dispatch two agents with the same role consecutively when another useful role is available.',
    '4. Read prior agent results carefully. Do not ask another agent to re-explain the same point; ask for a question, challenge, example, or concise summary instead.',
    '5. If the latest user message is a clear question and no agent has answered it yet, call the teacher first when available. Use the assistant fallback only under rule 6. Never start with a student for substantive explanation.',
    '6. For concept/mechanism/process questions, the first substantive answer should come from the teacher by default, or a teaching assistant when the teacher is unavailable or already answered. Students may react after the teacher/assistant has made the core point; do not let a student take the first substantive explanation.',
    '7. Never let one child agent impersonate other classroom agents. If another perspective is needed, call that agent separately.',
    '8. When the useful classroom agent turns are complete, call exactly one terminal tool. Do not keep calling agents after the answer is sufficient.',
    '9. Keep every call_agent instruction brief. Do not ask one child agent for a full lecture, multiple examples, or multiple named-student interactions.',
    '',
    `Session type: ${body.config.sessionType ?? 'qa'}`,
    `Current scene: ${currentScene?.title ?? currentScene?.id ?? 'none'}`,
    `Whiteboard open: ${body.storeState.whiteboardOpen ? 'yes' : 'no'}`,
    '',
    'Agents who already spoke before this Pi loop:',
    respondedList,
    '',
    'Available agents:',
    agentList || '(none)',
  ].join('\n');
}

export function buildChildPrompt(
  body: StatelessChatRequest,
  agent: AgentConfig,
  agentResponses: AgentTurnSummary[],
  whiteboardLedger: WhiteboardActionRecord[],
  availableActions: string[] = [],
): string {
  const currentScene = body.storeState.currentSceneId
    ? body.storeState.scenes.find((scene) => scene.id === body.storeState.currentSceneId)
    : null;

  return [
    `You are ${agent.name}.`,
    '',
    agent.persona,
    '',
    '# Classroom Role',
    buildRoleGuideline(agent.role),
    '',
    buildPeerContextSection(agentResponses, agent.name),
    buildLanguageConstraint(body.storeState.stage?.languageDirective),
    '',
    '# Length & Style (CRITICAL)',
    buildLengthGuidelines(agent.role),
    '- Speak conversationally and naturally. This is live classroom speech, not an essay.',
    '- NEVER use markdown formatting, headings, bullet lists, bold markers, blockquotes, or code fences in visible speech.',
    '- Lead with the direct answer when the user asked a concrete question.',
    '- Do not impersonate or script other named agents/students. Speak only as yourself.',
    '- Ask at most one short follow-up question.',
    '',
    '# Output Format (CRITICAL)',
    'Return ONLY a valid JSON array. Do not use markdown fences or any prose outside the JSON.',
    'Each array item must be either:',
    '{"type":"text","content":"natural classroom speech"}',
    '{"type":"action","name":"action_name","params":{}}',
    'Do not mention JSON, tools, internal director decisions, or implementation details inside visible speech.',
    'Use actions only when the target element or whiteboard content is clear from context.',
    'Actions are silent. Pair them with short natural speech when helpful.',
    'If you emit a whiteboard action, you MUST also include a text item explaining the key point shown on the board.',
    'Available actions for this turn:',
    getActionDescriptions(availableActions),
    buildSmartWhiteboardGuidelines(agent.role, availableActions),
    buildLiveSessionContext(body.piSessionBoundary),
    'Example:',
    '[{"type":"action","name":"spotlight","params":{"elementId":"text_1"}},{"type":"text","content":"看这里，这一步是后面机制成立的关键。"}]',
    '',
    '# Current State',
    buildStateContext(body.storeState),
    buildVirtualWhiteboardContext(body.storeState, whiteboardLedger),
    '',
    `Current scene: ${currentScene?.title ?? currentScene?.id ?? 'none'}`,
    `Stage title: ${body.storeState.stage?.name ?? 'unknown'}`,
    body.userProfile?.nickname ? `User nickname: ${body.userProfile.nickname}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRoleGuideline(role: string): string {
  if (role === 'teacher') {
    return [
      'Your role in this classroom: LEAD TEACHER.',
      '- Control lesson flow, slides, and pacing.',
      '- Explain concepts clearly, but avoid exhaustive lectures.',
      '- Ask questions to check understanding.',
      '- Use visual actions to direct attention without announcing them.',
    ].join('\n');
  }
  if (role === 'assistant') {
    return [
      'Your role in this classroom: TEACHING ASSISTANT.',
      '- Support the lead teacher by filling gaps or rephrasing briefly.',
      '- Provide one concrete example or angle when useful.',
      "- You play a supporting role. Don't take over the lesson.",
    ].join('\n');
  }
  return [
    'Your role in this classroom: STUDENT.',
    '- Participate only when you add student-side learning value: expose a common misconception, ask a natural follow-up the user might have, or give one concrete example.',
    '- You are NOT a teacher.',
    "- Keep responses much shorter than the teacher's.",
    '- Do not take the first substantive explanation, summarize the whole lesson, or start student-to-student self-chat.',
  ].join('\n');
}

function buildLengthGuidelines(role: string): string {
  if (role === 'teacher') {
    return [
      '- Keep your TOTAL visible speech around 70 Chinese characters or 1-2 short sentences.',
      '- This is a hard cap, not a suggestion.',
      '- Give the key insight in one crisp sentence, then optionally ask one short question.',
      '- Avoid exhaustive explanations unless the user explicitly asks for depth.',
    ].join('\n');
  }
  if (role === 'assistant') {
    return [
      '- Keep your TOTAL visible speech around 60 Chinese characters or 1-2 short sentences.',
      '- This is a hard cap, not a suggestion.',
      '- One key point per response. Do not repeat the teacher fully.',
    ].join('\n');
  }
  return [
    '- Keep your TOTAL visible speech around 40 Chinese characters. Prefer 1 short sentence.',
    '- This is a hard cap, not a suggestion.',
    '- Quick natural reaction only: one misconception, one follow-up question, or one concrete example.',
    '- If your response is as long as the teacher response, it is wrong.',
  ].join('\n');
}

function buildLanguageConstraint(langDirective?: string): string {
  return langDirective ? `# Language (CRITICAL)\n${langDirective}` : '';
}

const WHITEBOARD_DRAW_ACTIONS = [
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
];

function buildLiveSessionContext(boundary: StatelessChatRequest['piSessionBoundary']): string {
  if (!boundary?.isFirstRequestInLiveSession) return '';

  const lines = [
    '',
    '# Live Session Context',
    'This is the first request of a newly created UI live session.',
  ];
  if (boundary.previousEndSource) {
    lines.push(`The previous live session ended via: ${boundary.previousEndSource}.`);
  }
  if (boundary.sameSceneAsPrevious === true) {
    lines.push('The current scene is the same as the previous live session.');
  } else if (boundary.sameSceneAsPrevious === false) {
    lines.push('The current scene differs from the previous live session.');
  }
  lines.push(
    'This UI session boundary is NOT automatically a semantic topic boundary.',
    'Use the current slide and whiteboard state below to decide whether the existing board remains relevant.',
  );
  return lines.join('\n');
}

function buildSmartWhiteboardGuidelines(role: string, availableActions: string[]): string {
  const hasWhiteboard = availableActions.some((action) => WHITEBOARD_DRAW_ACTIONS.includes(action));
  const canClearWhiteboard = availableActions.includes('wb_clear');
  const hasSlidePointer =
    role === 'teacher' &&
    (availableActions.includes('spotlight') || availableActions.includes('laser'));

  if (!hasWhiteboard && !canClearWhiteboard && !hasSlidePointer) return '';

  const lines = [
    '',
    '# Smart Visual Teaching',
    hasWhiteboard
      ? [
          '- Whiteboard canvas: use a 1000 x 563 coordinate system. Keep all element boxes inside x=40..960 and y=40..523.',
          '- Use stable layouts instead of guessed/random positions: left concept, right mechanism, bottom summary.',
          '- Leave at least 24px between elements, keep text boxes wide enough, and use readable text (about 20-28px for labels).',
          '- Do not wait for the user to explicitly say "draw a diagram". For mechanism, cause/effect, process, comparison, or derivation questions, proactively use a concise whiteboard sketch when the visual adds teaching value.',
          '- Drawing is not the goal; better understanding is the goal. If the visual would not add information beyond one clear sentence, answer verbally.',
          '- For simple factual Q&A, short definitions, naming questions, or when the user asks for just one sentence, answer verbally without gratuitous drawing.',
          '- Choose visual type by teaching need: mechanism/causal -> wb_draw_shape + wb_draw_line; comparison -> wb_draw_table or two-column shapes; derivation -> wb_draw_latex; code explanation -> wb_draw_code; trend/data -> wb_draw_chart.',
          '- Prefer a small number of clear elements. Do not crowd the board.',
        ].join('\n')
      : '',
    canClearWhiteboard
      ? [
          '- Preserve the current whiteboard when the request references, continues, extends, or edits its content.',
          '- Use wb_clear only when the new topic is semantically unrelated, the existing board would cause confusion, or there is not enough space.',
          '- Do not clear merely because the user manually stopped earlier, a new UI session began, or the slide changed.',
        ].join('\n')
      : '',
    hasSlidePointer
      ? '- Slide priority override: if the current slide already adequately answers or covers the relevant diagram, term, formula, table, summary, or process step, use spotlight/laser on that slide element instead of opening or redrawing on the whiteboard. This override applies even when the user asks a mechanism/process/comparison/derivation question. If the slide is only partially related and does not answer the requested mechanism, process, comparison, or derivation, add a concise whiteboard sketch instead. Spotlight/laser are teacher-only visual actions.'
      : '- If you cannot use spotlight/laser, do not mention or attempt slide pointing; use only your available actions.',
    buildSmartWhiteboardFewShots(hasWhiteboard, hasSlidePointer),
  ];

  return lines.filter(Boolean).join('\n');
}

function buildSmartWhiteboardFewShots(hasWhiteboard: boolean, hasSlidePointer: boolean): string {
  const examples: string[] = [];

  if (hasWhiteboard) {
    examples.push(
      '- "Why does a zipper close when the slider moves?" -> draw a tiny cause chain: slider narrows teeth -> teeth interlock -> fabric edges join.',
      '- "How does a package move from checkout to delivery?" -> draw 3-4 process steps with arrows.',
      '- "What color do you get by mixing red and white?" -> no whiteboard; answer in one short sentence unless the user asks why.',
      '- "Define a peninsula in one sentence." -> no whiteboard; answer briefly.',
      '- "Compare renting and buying a textbook" -> use a small table or two columns.',
      '- "Derive rectangle perimeter from length and width" -> use wb_draw_latex plus one short explanation.',
    );
  }

  if (hasSlidePointer) {
    examples.push(
      '- Slide already adequately covers the relevant diagram, term, formula, table, summary, or process step -> teacher uses spotlight or laser on that element, then explains briefly; do not open the whiteboard or redraw the same thing.',
      '- Slide only has a related keyword but not the requested mechanism/process -> draw a concise whiteboard sketch instead of pretending the slide is enough.',
    );
  }

  if (examples.length === 0) return '';
  return ['', 'Few-shot choices:', ...examples].join('\n');
}

export function sanitizeVisibleSpeech(text: string): string {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/[*`#]/g, '');
}

export function createVisibleSpeechDeltaSanitizer(): (delta: string) => string {
  let rawText = '';
  let emittedLength = 0;

  return (delta: string) => {
    rawText += delta;
    const sanitizedText = sanitizeVisibleSpeech(rawText);
    if (sanitizedText.length <= emittedLength) return '';

    const visibleDelta = sanitizedText.slice(emittedLength);
    emittedLength = sanitizedText.length;
    return visibleDelta;
  };
}

export function buildChildTurnPrompt(instruction: string, role: string): string {
  return [
    instruction,
    '',
    '# Hard response cap',
    getChildHardCap(role),
    'If more explanation is useful, stop after your short contribution; the director can call another agent.',
    'Do not include markdown formatting or a multi-part outline.',
  ].join('\n');
}

function getChildHardCap(role: string): string {
  if (role === 'teacher') {
    return 'Your visible speech MUST be no more than 70 Chinese characters or 1-2 short sentences.';
  }
  if (role === 'assistant') {
    return 'Your visible speech MUST be no more than 60 Chinese characters or 1-2 short sentences.';
  }
  return 'Your visible speech MUST be no more than 40 Chinese characters or 1 short sentence.';
}

export function buildUserPrompt(body: StatelessChatRequest): string {
  const latestUserText = [...body.messages].reverse().find((message) => message.role === 'user');
  const discussion = body.config.discussionPrompt || body.config.discussionTopic;
  return [
    'Handle the latest classroom turn.',
    discussion ? `Discussion context: ${discussion}` : '',
    `Latest user message: ${latestUserText ? extractMessageText(latestUserText) : '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function toHistoryMessages(messages: StatelessChatRequest['messages']): AgentMessage[] {
  return messages
    .slice(-12)
    .map((message): AgentMessage | null => {
      const text = extractMessageText(message).trim();
      if (!text) return null;
      if (message.role === 'user') return { role: 'user', content: text, timestamp: Date.now() };
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: 'unknown',
          provider: 'unknown',
          model: 'history',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        };
      }
      return null;
    })
    .filter((message): message is AgentMessage => Boolean(message));
}

function extractMessageText(message: StatelessChatRequest['messages'][number]): string {
  return (message.parts ?? [])
    .map((part) => {
      if (part.type === 'text') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    return message.content
      .map((content) => (content.type === 'text' ? content.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
