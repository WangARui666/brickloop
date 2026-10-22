import type { ModelCapabilities, ModelInfo } from '../types.js';

export type SetupAdapter = 'openai' | 'compatible' | 'anthropic' | 'gemini';
export type ModelPurpose = 'chat' | 'vision' | 'quick';
type Localized = { 'zh-CN': string; en: string };
export interface ProviderPreset {
  id: string;
  name: Localized;
  description: Localized;
  adapter: SetupAdapter;
  endpoint: string;
  overseasEndpoint?: string;
  /** Previously documented addresses, used only to recognize saved configurations. */
  aliases?: string[];
  keyUrl: string | null;
  docsUrl: string;
  keyHint: Localized;
  requiresKey: boolean;
  recommendations: Record<ModelPurpose, string[]>;
  capabilities: {
    match: string;
    vision: boolean;
    tools: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoningReplay?: boolean;
    thinkingControl?: ModelCapabilities['thinkingControl'];
  }[];
  verified: { date: string; sources: string[] };
}
const localized = (zh: string, en: string): Localized => ({ 'zh-CN': zh, en });
const genericHint = localized(
  '粘贴开放平台的完整 API Key，不要添加 Bearer 或引号。',
  'Paste the full platform API key, without Bearer or quotation marks.',
);
const commonRules = {
  chat: [
    '(?:astra|opus|pro|plus|reasoner|thinking)',
    '(?:chat|instruct|sonnet|gpt|qwen|glm|kimi|deepseek|minimax|ernie|hunyuan|hy[0-9])',
  ],
  vision: ['(?:vision|vl|omni)', '(?:gpt|claude|gemini)'],
  quick: ['(?:flash|mini|lite|haiku|turbo|small)', '(?:chat|instruct)'],
};
const commonCapabilities = [
  { match: '(?:vision|[-/]vl|omni)', vision: true, tools: true },
  { match: '(?:gpt-[4-9]|claude-|gemini-)', vision: true, tools: true },
  { match: '(?:qwen|llama|mistral|deepseek|glm|kimi|minimax|ernie|hunyuan|hy[0-9])', vision: false, tools: true },
];
function preset(
  value: Pick<ProviderPreset, 'id' | 'name' | 'description' | 'endpoint' | 'docsUrl' | 'keyUrl'> &
    Partial<ProviderPreset>,
): ProviderPreset {
  return {
    adapter: 'compatible',
    requiresKey: true,
    keyHint: genericHint,
    recommendations: commonRules,
    capabilities: commonCapabilities,
    verified: { date: '2026-10-19', sources: [value.docsUrl] },
    ...value,
  };
}
/** Official documentation reviewed on the date on each entry; no live credentials used. */
export const providerPresets: readonly ProviderPreset[] = [
  preset({
    id: 'deepseek',
    name: localized('DeepSeek', 'DeepSeek'),
    description: localized(
      '国内直连，适合推理与日常设计。',
      'Direct access in China for reasoning and everyday design.',
    ),
    endpoint: 'https://api.deepseek.com',
    aliases: ['https://api.deepseek.com/v1'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    recommendations: {
      chat: ['^deepseek-flash$', '^deepseek.*flash', '^deepseek.*reasoner', '^deepseek.*chat'],
      vision: ['^deepseek-flash$', '^deepseek.*vision', '^deepseek.*flash'],
      quick: ['^deepseek-flash$', '^deepseek.*flash', '^deepseek.*chat', '^deepseek'],
    },
    verified: {
      date: '2026-10-20',
      sources: [
        'https://api-docs.deepseek.com/quick_start/pricing',
        'https://api-docs.deepseek.com/api/create-chat-completion',
        'https://api-docs.deepseek.com/guides/thinking_mode',
      ],
    },
    capabilities: [
      // Image input confirmed by the user's real-service test on 2026-10-19.
      {
        match: '^deepseek.*flash',
        thinkingControl: 'deepseek',
        vision: true,
        tools: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        reasoningReplay: true,
      },
      {
        match: '^deepseek.*(?:vision|flash)',
        vision: true,
        tools: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        reasoningReplay: true,
      },
      {
        match: '^deepseek',
        vision: false,
        tools: true,
        contextWindow: 1_000_000,
        maxOutputTokens: 393_216,
        reasoningReplay: true,
      },
    ],
  }),
  preset({
    id: 'qwen',
    name: localized('通义千问（阿里云百炼）', 'Qwen (Alibaba Cloud Model Studio)'),
    description: localized('国内与海外可选，含看图模型。', 'China and overseas endpoints, with vision models.'),
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    overseasEndpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/settings/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/base-url',
    keyHint: localized(
      '粘贴百炼按量付费 Key；国内与海外 Key 不通用。',
      'Use a pay-as-you-go Model Studio key for the selected region.',
    ),
    recommendations: {
      chat: ['^qwen(?!.*(?:vl|omni)).*max', '^qwen(?!.*(?:vl|omni)).*plus', '^qwen'],
      vision: ['^qwen.*vl.*max', '^qwen.*vl', '^qwen.*omni'],
      quick: ['^qwen.*flash', '^qwen.*turbo', '^qwen'],
    },
  }),
  preset({
    id: 'doubao',
    name: localized('豆包（火山方舟）', 'Doubao (Volcano Ark)'),
    description: localized('国内直连，可使用已开通的模型。', 'Access models enabled in your Volcano Ark account.'),
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
    docsUrl: 'https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh',
    keyHint: localized(
      '粘贴方舟 API Key；如无模型列表，请填写已开通的模型名或推理接入点。',
      'Paste an Ark API key; enter an enabled model or inference endpoint ID if no list is available.',
    ),
    capabilities: [
      { match: '^doubao.*(?:vision|seed)', vision: true, tools: true },
      { match: '^doubao', vision: false, tools: true },
    ],
  }),
  preset({
    id: 'kimi',
    name: localized('Kimi（月之暗面开放平台）', 'Kimi (Moonshot Open Platform)'),
    description: localized(
      '开放平台按量付费，不使用 Kimi 会员。',
      'Pay-as-you-go platform access, separate from Kimi membership.',
    ),
    endpoint: 'https://api.moonshot.cn/v1',
    overseasEndpoint: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api',
    verified: {
      date: '2026-10-19',
      sources: [
        'https://platform.moonshot.cn/docs/guide/start-using-kimi-api',
        'https://platform.moonshot.ai/docs/guide/start-using-kimi-api',
      ],
    },
    keyHint: localized(
      '粘贴开放平台 API Key；Kimi 会员 Key 和编程套餐不能用于此处。',
      'Use an Open Platform key, not a Kimi membership or coding-plan key.',
    ),
    capabilities: [
      { match: '^kimi-k(?:2\\.[5-9]|[3-9])', vision: true, tools: true },
      { match: '(?:vision|vl)', vision: true, tools: true },
      { match: '^(?:kimi|moonshot)', vision: false, tools: true },
    ],
  }),
  preset({
    id: 'zhipu',
    name: localized('智谱 GLM', 'Zhipu GLM'),
    description: localized('国内直连，提供对话与看图模型。', 'Chat and vision models with direct access in China.'),
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/quick-start',
    capabilities: [
      { match: '^glm.*v(?:-|$)', vision: true, tools: true },
      { match: '^glm', vision: false, tools: true },
    ],
  }),
  preset({
    id: 'siliconflow',
    name: localized('硅基流动', 'SiliconFlow'),
    description: localized('一个 Key 使用多种开放模型。', 'Access multiple open models with one key.'),
    endpoint: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/docs/userguide/capabilities/text-generation',
  }),
  preset({
    id: 'minimax',
    name: localized('MiniMax', 'MiniMax'),
    description: localized('开放平台按量付费，适合长任务。', 'Pay-as-you-go platform models for extended tasks.'),
    endpoint: 'https://api.minimax.cn/v1',
    aliases: ['https://api.minimaxi.com/v1'],
    keyUrl: 'https://platform.minimax.cn/console/access?tab=api-keys',
    docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
    verified: {
      date: '2026-10-19',
      sources: [
        'https://platform.minimax.cn/docs/api-reference/text-openai-api',
        'https://platform.minimax.cn/docs/guides/quickstart-preparation',
      ],
    },
    capabilities: [
      { match: '^minimax-m[3-9]', vision: true, tools: true },
      { match: '^minimax-m2', vision: false, tools: true },
    ],
  }),
  preset({
    id: 'hunyuan',
    name: localized('腾讯混元', 'Tencent Hunyuan'),
    description: localized('通过腾讯 TokenHub 接入混元模型。', 'Access Hunyuan models through Tencent TokenHub.'),
    endpoint: 'https://tokenhub.tencentmaas.com/v1',
    aliases: ['https://api.hunyuan.cloud.tencent.com/v1'],
    keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
    docsUrl: 'https://cloud.tencent.com/document/product/1823/132252',
    keyHint: localized(
      '粘贴 TokenHub 的 API Key，不使用腾讯云 SecretKey。旧混元地址可在高级设置中保留。',
      'Paste a TokenHub API key, not a Tencent Cloud SecretKey. Legacy endpoints can be retained in advanced settings.',
    ),
  }),
  preset({
    id: 'qianfan',
    name: localized('百度千帆', 'Baidu Qianfan'),
    description: localized('国内直连，使用千帆模型服务。', 'Access Qianfan model services in China.'),
    endpoint: 'https://qianfan.baidubce.com/v2',
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
    keyHint: localized(
      '粘贴完整 API Key（可能以 bce-v3/ 开头），不要填 Access Key / Secret Key。',
      'Paste the full API key (which may begin with bce-v3/), not an Access Key / Secret Key pair.',
    ),
  }),
  preset({
    id: 'openai',
    name: localized('OpenAI', 'OpenAI'),
    description: localized(
      '使用 OpenAI API 余额，与 ChatGPT 订阅分开。',
      'Uses API billing, separate from your ChatGPT subscription.',
    ),
    adapter: 'openai',
    endpoint: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://developers.openai.com/api/reference/overview',
    recommendations: {
      ...commonRules,
      chat: ['^gpt-.*astra', '^gpt-.*pro', '^gpt-', '^o[0-9]'],
      vision: ['^gpt-'],
      quick: ['^gpt-.*(?:mini|nano|luna)', '^gpt-.*sol', '^gpt-'],
    },
  }),
  preset({
    id: 'anthropic',
    name: localized('Anthropic（Claude）', 'Anthropic (Claude)'),
    description: localized(
      '使用 Claude API，不使用 Claude 订阅。',
      'Uses the Claude API, separate from Claude subscriptions.',
    ),
    adapter: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    keyUrl: 'https://platform.claude.com/settings/keys',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview',
  }),
  preset({
    id: 'gemini',
    name: localized('Google Gemini', 'Google Gemini'),
    description: localized('使用 Google AI Studio 的 API Key。', 'Connect using a Google AI Studio API key.'),
    adapter: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
  }),
  preset({
    id: 'openrouter',
    name: localized('OpenRouter', 'OpenRouter'),
    description: localized('一个 Key 选择多个服务商的模型。', 'Choose models from multiple providers with one key.'),
    endpoint: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/quickstart',
  }),
  ...[
    ['ollama', 'Ollama', '11434', 'https://docs.ollama.com/api/openai-compatibility'],
    ['lmstudio', 'LM Studio', '1234', 'https://lmstudio.ai/docs/developer/openai-compat'],
    ['vllm', 'vLLM', '8000', 'https://docs.vllm.ai/en/latest/examples/basic/online_serving/'],
  ].map(([id, name, port, docsUrl]) =>
    preset({
      id: id!,
      name: localized(name!, name!),
      description: localized(
        '连接本机已启动的模型服务，无需 Key。',
        'Connect to a running local model server without a key.',
      ),
      endpoint: `http://127.0.0.1:${port}/v1`,
      keyUrl: null,
      docsUrl: docsUrl!,
      requiresKey: false,
      keyHint: localized('请先启动本机服务并加载模型。', 'Start the local server and load a model first.'),
    }),
  ),
  preset({
    id: 'custom',
    name: localized('自定义（OpenAI 兼容）', 'Custom (OpenAI compatible)'),
    description: localized('填写服务地址，可选择其他协议。', 'Enter a service address and choose its protocol.'),
    endpoint: 'http://127.0.0.1:8000/v1',
    keyUrl: null,
    docsUrl: 'https://developers.openai.com/api/reference/overview',
    requiresKey: false,
    keyHint: localized(
      '按服务商要求填写；无密钥的本机服务可留空。',
      'Enter a key if required; unauthenticated local servers can leave it blank.',
    ),
  }),
];
export const getProviderPreset = (id?: string) => providerPresets.find((p) => p.id === id);
export function matchProviderPreset(type: string, endpoint: string): string {
  if (type === 'chatgpt') return 'chatgpt';
  const normalize = (value: string) => {
    const url = new URL(value);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.href.replace(/\/+$/, '');
  };
  try {
    const address = normalize(endpoint);
    return (
      providerPresets.find(
        (p) =>
          p.id !== 'custom' &&
          p.adapter === type &&
          [p.endpoint, p.overseasEndpoint, ...(p.aliases ?? [])].some((v) => v && normalize(v) === address),
      )?.id ?? 'custom'
    );
  } catch {
    return 'custom';
  }
}
export function presetCapabilities(
  presetId: string | undefined,
  model: string,
): Omit<ModelCapabilities, 'contextWindow' | 'maxOutputTokens' | 'reasoningReplay'> & {
  known: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoningReplay: boolean;
} {
  const rule = getProviderPreset(presetId === 'chatgpt' ? 'openai' : presetId)?.capabilities.find((r) =>
    new RegExp(r.match, 'i').test(model),
  );
  return {
    vision: rule?.vision ?? false,
    tools: rule?.tools ?? false,
    reasoning: true,
    maxContext: rule?.contextWindow ?? 0,
    contextWindow: rule?.contextWindow ?? null,
    maxOutputTokens: rule?.maxOutputTokens ?? null,
    reasoningReplay: rule?.reasoningReplay ?? false,
    ...(rule?.thinkingControl ? { thinkingControl: rule.thinkingControl } : {}),
    known: !!rule,
  };
}
export function recommendModels(
  presetId: string | undefined,
  models: readonly Pick<ModelInfo, 'id'>[],
): Record<ModelPurpose, string> {
  const preset = getProviderPreset(presetId === 'chatgpt' ? 'openai' : presetId);
  const ids = [...new Set(models.map((m) => m.id))].filter((id) => presetId !== 'deepseek' || !/pro/i.test(id));
  // Numeric ordering prefers newer available families without pinning a version in recommendations.
  const ranked = [...ids].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const pick = (purpose: ModelPurpose) => {
    const capable = ranked.filter(
      (id) => purpose === 'quick' || presetCapabilities(presetId, id)[purpose === 'chat' ? 'tools' : 'vision'],
    );
    const candidates = capable.length ? capable : ranked;
    for (const rule of preset?.recommendations[purpose] ?? commonRules[purpose]) {
      const found = candidates.find((id) => new RegExp(rule, 'i').test(id));
      if (found) return found;
    }
    return capable[0] ?? ids[0] ?? '';
  };
  return { chat: pick('chat'), vision: pick('vision'), quick: pick('quick') };
}
/** Legacy consumers keep their original import and object shape. */
export const compatiblePresets = Object.fromEntries(
  providerPresets
    .filter((p) => p.adapter === 'compatible' && p.id !== 'custom')
    .map((p) => [
      p.id,
      {
        name: p.name['zh-CN'],
        baseURL: p.endpoint,
        vision: p.capabilities.some((r) => r.vision),
        tools: p.capabilities.some((r) => r.tools),
      },
    ]),
);
