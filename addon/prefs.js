pref("provider.active", "openai");

pref("provider.openai.baseURL", "https://api.openai.com/v1");
pref("provider.openai.apiKey", "");
pref("provider.openai.model", "");
pref("provider.openai.maxTokens", 8192);
pref("provider.openai.extraHeaders", "{}");
pref("provider.openai.models", "");

pref("provider.anthropic.baseURL", "https://api.anthropic.com");
pref("provider.anthropic.apiKey", "");
pref("provider.anthropic.model", "claude-opus-5-5");
pref("provider.anthropic.maxTokens", 8192);
pref("provider.anthropic.extraHeaders", "{}");
pref(
  "provider.anthropic.models",
  "claude-opus-5-5\nclaude-sonnet-5-5\nclaude-haiku-5-5",
);

pref("context.maxHistoryMessages", 20);
pref("model.profiles", "{}");

pref(
  "prompt.system",
  "你是论文阅读助手。请基于提供的论文内容回答用户问题；引用原文时尽量指出所在章节或页码，不确定时明确说明。",
);

/* 空字符串表示使用内置预设；用户一旦在设置页增删，就整体保存为 JSON 数组。 */
pref("prompt.presets", "");
