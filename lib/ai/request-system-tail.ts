import type { LanguageModelMiddleware, SystemModelMessage } from 'ai';

/** Tag only request-local host state, so adapter compatibility never moves history. */
export function hostSystemTailMessage(content: string): SystemModelMessage {
  return {
    role: 'system',
    content,
    providerOptions: { openmaic: { requestSystemTail: true } },
  };
}

/** Some transports require every system instruction before the first conversation turn. */
export function prefixSystemTailMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const tails = params.prompt.filter(
        (message) =>
          message.role === 'system' &&
          message.providerOptions?.openmaic?.requestSystemTail === true,
      );
      if (!tails.length) return params;
      const prompt = params.prompt.filter((message) => !tails.includes(message));
      const tail = tails.map((message) => message.content).join('\n');
      if (prompt[0]?.role === 'system') {
        prompt[0] = { ...prompt[0], content: `${prompt[0].content}\n${tail}` };
      } else {
        prompt.unshift({ role: 'system', content: tail });
      }
      return { ...params, prompt };
    },
  };
}
