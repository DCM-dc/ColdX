const TEXT_ONLY = /(?:只要|只用|仅用|仅需|仅限|使用|保持)?纯文字|(?:只|仅)(?:用|要|需|输出|回复|回答)?(?:文字|文本)|(?:不需要|不要|不用|无需)(?:生成|展示|创建|打开)?(?:任何)?(?:交互式)?(?:网页|页面|页|界面|交互面板)|(?:一句话|简短(?:回答|回复|说明))|(?:用|只用|仅用)\s*(?:一|两|二|三|四|五|\d+)\s*(?:句|句话|行|点)|(?:只|仅)(?:输出|返回)?\s*(?:Markdown|JSON|代码(?:块)?|一条命令)|\b(?:text[ -]only|no (?:ui|pages?|interface)|do not (?:create|show|generate) (?:a )?(?:page|ui|interface)|(?:in|using|with) (?:one|two|three|four|five|\d+) (?:sentences?|lines?|bullets?)|(?:markdown|json|code|one command) only|return only (?:markdown|json|code|one command))\b/i;

/** Preserve an explicit user request for compact text in the derived result projection. */
export function isExplicitTextOnly(value) {
  return typeof value === 'string' && TEXT_ONLY.test(value);
}
