// SPDX-License-Identifier: Apache-2.0
// W-26 (v0.7) for the shield (N-02): phrases aimed at an AI, in the thirteen languages Tiresias detects.
// Which lists run on a piece of text is decided by the piece's own scripts (lang.ts, scriptOf), every time the
// shield scans: Latin script runs every Latin-script list, Cyrillic Russian, Arabic script Arabic, Devanagari
// Hindi, Hangul Korean, kana Japanese, Han Chinese and Japanese. So a mixed page is checked in every language
// found, piece by piece (docs/v0.7/translate.md).
//
// Written as plain phrases: a space matches any run of white space (" ?" any or none), "(a|b)" and "(x )?" are the only operators,
// so no pattern can backtrack badly. Latin-script lists are written without accents and matched on the text with
// its accents removed, so "ignorá las instrucciónes" matches too.
import { scriptOf, type Lang } from "./lang.js";

// English: the v0.1 list, unchanged (matched on the normalized text as before).
export const EN: RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|messages?)/i,
  /ignore all prior/i,
  /disregard (all |any )?(of )?(the )?(above|previous|prior)/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\bas an ai\b/i,
  /\bassistant:/i,
  /\bnew instructions\b/i,
];

type Other = Exclude<Lang, "en">;
const SRC: Record<Other, string[]> = {
  es: [
    "(ignora|ignore|ignorar|ignorad|ignoren) (todas |todos )?(las |los )?(instrucciones|indicaciones|ordenes|mensajes|reglas) (anteriores|previas|de arriba|precedentes)",
    "(olvida|olvide|olvidar|olvidad) (todas |todos )?(las |los )?(instrucciones|indicaciones|ordenes|reglas) (anteriores|previas)",
    "(no hagas caso|haz caso omiso) (a |de )?(todas )?(las )?instrucciones (anteriores|previas)",
    "(prompt|mensaje|indicaciones) del sistema", "nuevas instrucciones", "(a partir de )?ahora eres un",
  ],
  fr: [
    "(ignore|ignorez|ignorer) (toutes |tous )?(les )?(instructions|consignes|messages|regles) (precedentes|precedents|ci-dessus|anterieures)",
    "(oublie|oubliez|oublier) (toutes |tous )?(les )?(instructions|consignes|regles) (precedentes|anterieures|ci-dessus)",
    "(prompt|invite|message) (du )?systeme", "nouvelles (instructions|consignes)", "(tu es|vous etes) (maintenant|desormais)",
  ],
  de: [
    "(ignoriere|ignorieren|ignoriert|ignorier) (sie )?(alle )?(die )?(vorherigen|bisherigen|obigen|vorangegangenen|fruheren|vorigen) (anweisungen|instruktionen|befehle|nachrichten|regeln)",
    "(vergiss|vergessen sie) (alle )?(die )?(vorherigen|bisherigen|obigen|fruheren|vorigen) (anweisungen|instruktionen|befehle|regeln)",
    "system-?prompt", "systemanweisung(en)?", "neue anweisungen", "(du bist|sie sind) (jetzt|nun|ab jetzt|ab sofort) (ein|eine)",
  ],
  pt: [
    "(ignore|ignora|ignorar|ignorem) (todas |todos )?(as |os )?(instrucoes|orientacoes|mensagens|regras|ordens) (anteriores|acima|previas)",
    "(esqueca|esquece|esquecer|esquecam) (todas |todos )?(as |os )?(instrucoes|orientacoes|regras) (anteriores|previas|acima)",
    "(prompt|mensagem) do sistema", "novas instrucoes", "(voce|tu) (agora )?(e|es) agora um", "a partir de agora (voce|tu) (e|es)",
  ],
  it: [
    "(ignora|ignorare|ignorate|ignori) (tutte |tutti )?(le |i )?(istruzioni|indicazioni|messaggi|regole) (precedenti|sopra|di sopra)",
    "(dimentica|dimenticare|dimenticate) (tutte |tutti )?(le |i )?(istruzioni|indicazioni|regole) (precedenti|sopra)",
    "prompt di sistema", "nuove istruzioni", "da (ora|adesso) (in poi )?(sei|tu sei)",
  ],
  nl: [
    "(negeer|negeren) (alle )?(de )?(vorige|eerdere|voorgaande|bovenstaande) (instructies|opdrachten|berichten|regels)",
    "(vergeet|vergeten) (alle )?(de )?(vorige|eerdere|voorgaande|bovenstaande) (instructies|opdrachten|regels)",
    "systeemprompt", "nieuwe instructies", "(je bent|jij bent|u bent) (nu|vanaf nu)",
  ],
  ru: [
    "(игнорируй|игнорируйте|проигнорируй|проигнорируйте) (все )?(предыдущие|прежние|вышеуказанные|вышеприведенные|прошлые) (инструкции|указания|сообщения|команды|правила)",
    "(забудь|забудьте) (все )?(предыдущие|прежние|вышеуказанные|прошлые) (инструкции|указания|команды|правила)",
    "(не обращай|не обращайте) внимания на (все )?(предыдущие|прежние) (инструкции|указания)",
    "системн(ый|ого|ому) (промпт|запрос)", "новые (инструкции|указания)",
  ],
  zh: [
    "(忽略|无视|無視|忘记|忘記|不要理会|不要理會)(之前|以前|上面|上述|先前|前面|以上)(的)?(所有|全部)?(的)?(指令|指示|说明|說明|提示|规则|規則)",
    "(系统|系統)(提示词|提示詞|提示)", "新的(指令|指示)", "你现在是", "你現在是",
  ],
  ja: [
    "(以前|前|上記|これまで|先|上)の(すべての|全ての)?(指示|命令|指令|プロンプト|ルール)を(すべて|全て)?(無視|忘れ)",
    "システムプロンプト", "新しい(指示|命令)", "(あなたは今から|今からあなたは)",
  ],
  ko: [
    "(이전|앞의|위의|이전의|지금까지의) (모든 )?(지시|지침|명령|프롬프트|규칙)(을|를|사항을|들을)? ?(모두 )?(무시|잊어)",
    "시스템 ?프롬프트", "새로운 (지시|지침|명령)", "(너는|당신은) 이제",
  ],
  ar: [
    "(تجاهل|تجاهلي|تجاهلوا|انس|انسى|انسي) (جميع |كل )?(التعليمات|الأوامر|الاوامر|الإرشادات|الارشادات|التوجيهات) (السابقة|أعلاه|اعلاه)",
    "(موجه|تعليمات|رسالة) النظام", "تعليمات جديدة", "أنت الآن", "انت الان",
  ],
  hi: [
    "(पिछले|पिछली|पहले के|पहले दिए गए|ऊपर के|ऊपर दिए गए) (सभी |सारे )?(निर्देशों|निर्देश|आदेशों|आदेश) (को )?(अनदेखा|नज़रअंदाज़|नजरअंदाज|भूल)",
    "सिस्टम प्रॉम्प्ट", "नए निर्देश",
  ],
};
const LATIN_OTHER: Other[] = ["es", "fr", "de", "pt", "it", "nl"];
const NO_SPACE = new Set<Other>(["zh", "ja", "ko"]); // no word edges: written without spaces (zh, ja), or endings join the word (ko)

// Compiled once. Phrases are NFKC-normalized like the text they are matched against; Latin-script and
// Cyrillic, Arabic and Devanagari phrases must start and end at a word edge.
const compile = (l: Other, s: string): RegExp => {
  const body = s.normalize("NFKC").replace(/ \?/g, "\\s*").replace(/ /g, "\\s+");
  return new RegExp(NO_SPACE.has(l) ? body : `(?<![\\p{L}\\p{M}\\p{N}])${body}(?![\\p{L}\\p{M}\\p{N}])`, "iu");
};
const LISTS = new Map<Other, RegExp[]>((Object.keys(SRC) as Other[]).map((l) => [l, SRC[l].map((s) => compile(l, s))]));

// The accents of Latin letters removed (NFD, then the combining marks U+0300 to U+036F dropped), so a phrase
// written without them matches either way. Only used for the Latin-script lists, which match on this text only.
export const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");

// The non-English lists to run on a normalized text, from the scripts it contains (one pass, bounded by the
// shield's own cap on the text).
export function listsFor(norm: string): Other[] {
  const seen = new Set<string>();
  // By index, not `for of` (no string per character: the text can be 200,000 characters).
  for (let i = 0; i < norm.length; i++) {
    const cp = norm.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp < 0x41) continue;
    const s = scriptOf(cp);
    if (s) seen.add(s);
    if (seen.size >= 7) break;
  }
  const out: Other[] = [];
  if (seen.has("latin")) out.push(...LATIN_OTHER);
  if (seen.has("cyrillic")) out.push("ru");
  if (seen.has("arabic")) out.push("ar");
  if (seen.has("devanagari")) out.push("hi");
  if (seen.has("hangul")) out.push("ko");
  if (seen.has("han")) out.push("zh");
  if (seen.has("kana") || seen.has("han")) out.push("ja");
  return out;
}

// A cheap first look per Latin-script language (one pass over the folded, lowercased text): a list runs only
// when one of its key words is there, so a long page does not pay for six lists it cannot match.
const KEYS: Record<"es" | "fr" | "de" | "pt" | "it" | "nl", RegExp> = {
  es: /instruc|indicacion|ordenes|mensajes|reglas|sistema|ahora eres/,
  fr: /instruction|consigne|messages|regles|systeme|maintenant|desormais/,
  de: /anweisung|instruktion|befehle|nachrichten|regeln|system|jetzt|nun|ab sofort/,
  pt: /instruc|orientac|mensagens|regras|ordens|sistema|agora/,
  it: /istruzion|indicazion|messaggi|regole|sistema|da ora|da adesso/,
  nl: /instructie|opdracht|bericht|regels|systeemprompt|bent nu|bent vanaf/,
};

// Every non-English phrase found in a normalized text: the language and where (in the text it was found in:
// for a Latin-script language, the text with its accents removed).
export function otherMatches(norm: string): { lang: Other; index: number; text: string }[] {
  const out: { lang: Other; index: number; text: string }[] = [];
  const langs = listsFor(norm);
  if (!langs.length) return out;
  let folded: string | null = null;
  let lower: string | null = null;
  for (const l of langs) {
    let text = norm;
    if (l in KEYS) {
      folded ??= stripAccents(norm);
      lower ??= folded.toLowerCase();
      if (!KEYS[l as keyof typeof KEYS].test(lower)) continue;
      text = folded;
    }
    for (const re of LISTS.get(l)!) {
      const m = re.exec(text);
      if (m) out.push({ lang: l, index: m.index, text });
    }
  }
  return out;
}
