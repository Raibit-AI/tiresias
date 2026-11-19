// SPDX-License-Identifier: Apache-2.0
// v1.2: the same aimed-at-an-AI patterns for full replies and local replies.
// Patterns for text that addresses an AI, beside the shield's own phrase lists, each with how many signals a match
// counts as. Every repeat is bounded, so no pattern can backtrack badly: each one costs at most a fixed amount of work
// per character scanned. On 567 ordinary passages from 30 real pages they marked 2 (both in Wikipedia's "Prompt
// injection" article), and they caught 1 of 5 held-out attacks: a best effort, not a guarantee. A pattern joins this
// table only with a reason that can be stated.
// Chat template markers and role tags weigh WITHHOLD_AT on their own: a planted <|im_start|>system block got through
// with a warning alone (three of four models obeyed it), a local runtime may read such markers as real control
// tokens, and neither pattern fired once on the 567 ordinary passages.
export const AIMED: Record<string, { re: RegExp; weight: number }> = {
  addressed: { re: /\b(attention|notice|note|message|instructions?)\b[^.\n]{0,40}\b(to|for)\b[^.\n]{0,20}\b(ai|a\.i\.|llm|language model|chatbot)s?\b/i, weight: 1 },
  ai_must: { re: /\b(ai|a\.i\.|llm|language model|chatbot)s? ?(assistants?|agents?|models?|systems?)?\b[^.\n]{0,30}\b(must|should|are required to|have to|need to)\b[^.\n]{0,40}\b(ignore|reply|respond|answer|say|tell|include|read|visit|output|end)\b/i, weight: 1 },
  assistant_must: { re: /\b(the )?assistant (must|should|will|has to)\b/i, weight: 1 },
  system_message: { re: /\bsystem (message|prompt|instructions?)\b\s{0,20}[:\-]|^\s{0,20}system\s{0,20}:/im, weight: 1 },
  chat_tokens: { re: /<\|[a-z_]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>/i, weight: 2 },
  role_tags: { re: /<\/?(tool_response|tool_call|tool_result|system|assistant|user)>/i, weight: 2 },
  reply_only: { re: /\b(reply|respond|answer) (only )?with (only )?(the )?(single )?(words?|sentence|phrase)\b/i, weight: 1 },
  ignore_user: { re: /\bignore (the |all |any )?(user|users|user's|above|previous|prior|earlier)\b/i, weight: 1 },
  your_tool: { re: /\b(use|with|call) your (read|browser|search|fetch|web) tool\b/i, weight: 1 },
  role_line: { re: /^\s{0,20}(user|assistant)\s{0,20}:/im, weight: 1 },
  envelope_keys: { re: /"(status|notice|untrusted_content)"\s{0,20}:/i, weight: 1 },
};

