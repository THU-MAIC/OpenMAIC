/**
 * Provider 推广位链接（国内/海外双地址）。
 *
 * 用于「模型服务」provider 列表与配置面板：置顶/强调的 provider 附带获取
 * API key 的跳转入口。链接按界面语言分流——中文 locale 走国内地址，其余走
 * 海外地址；面板内两个链接都直接可见。
 */
export interface RegionalLinks {
  domestic: string;
  international: string;
}

export const PROVIDER_SIGNUP_LINKS: Partial<Record<string, RegionalLinks>> = {
  kimi: {
    domestic: 'https://platform.kimi.com?aff=openmaic',
    international: 'https://platform.kimi.ai?aff=openmaic',
  },
};

/** 列表行上的单一跳转按 locale 分流；面板里两个都展示。 */
export function pickRegionalLink(links: RegionalLinks, locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? links.domestic : links.international;
}

/** 「模型服务」provider 列表的置顶 provider：排在列表首位。 */
export const PINNED_PROVIDER_ID = 'kimi';
