// SPDX-License-Identifier: Apache-2.0
// W-04: forms as permission-gated actions.
//
// Three jobs, all pure (no I/O), so they run in the worker like the rest of HTML parsing:
// - extractForms: find a page's forms and their fields in the parsed DOM (bounded, iterative).
// - publicForm:   the listing an agent sees. Hidden fields are named only, their values never shown.
// - buildRequest: check an agent's values against a form and build the EXACT request that would be
//   sent, plus a preview with every hidden value replaced by "[set by the site]" and a preview hash.
// And one helper for the send itself: CookieJar, the in-memory cookies of ONE submit call.
//
// Refused forms (listed with a fixed `not_allowed` code, never previewed or sent): a password field or
// a login code field (login_or_password: logins are never handled, N-05), a file input or a multipart
// form (file_upload), anything that looks like payment (payment: this version never pays), a CAPTCHA widget
// (captcha: a person's job), an action that is not http(s) (bad_action), a method other than GET or
// POST (bad_method), an encoding other than urlencoded (bad_enctype), and forms Tiresias cannot show
// whole: more than 100 fields (too_many_fields), one visible name used by two different fields
// (duplicate_names), a listing or a default value too large to show exactly (too_large).
import { createHash } from "node:crypto";
import { listsFor, stripAccents } from "./shieldphrases.js";
import type { Lang } from "./lang.js";
import { MAX_URL } from "./types.js";

interface N {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: N[];
  data?: string;
}

export const MAX_FORMS = 20; // per page; the rest are counted (forms_omitted)
export const MAX_FIELDS = 100; // per form; a form with more is listed but never sent (too_many_fields)
export const MAX_OPTIONS = 50; // per select, radio or checkbox field; the rest are counted and cannot be chosen
export const MAX_NAME = 200; // characters of a field name (a longer one makes the form too_large: a cut name is another name)
export const MAX_LABEL = 200; // characters of a label shown (display only)
export const MAX_OPTION_LABEL = 100;
export const MAX_OPTION_VALUE = 500; // characters; a longer option is omitted (counted) and cannot be chosen
export const MAX_PATTERN = 200; // a longer pattern attribute is not shown (display only, never run)
export const MAX_LISTING = 24_000; // UTF-8 bytes of one form's listing; over it the form is too_large
export const MAX_VALUE = 4_000; // UTF-8 bytes of one value (the agent's, or a default shown)
export const MAX_VALUES = 12_000; // UTF-8 bytes of all the agent's values together
export const MAX_KEYS = 100; // names in one set of values
export const MAX_BODY = 1024 * 1024; // bytes of the encoded request, hidden values included
export const MAX_TARGET = 8192; // characters of a GET target URL (query included), the robots path limit
export const MAX_PREVIEW = 30_000; // UTF-8 bytes of the previewed request (URL plus body as shown)
const NODE_BUDGET = 200_000;
const TEXT_BUDGET = 400_000; // nodes read for all label texts of one page together

export const HIDDEN_VALUE = "set by the site"; // what a hidden field's value is shown as in a listing
export const HIDDEN_IN_PREVIEW = "[set by the site]"; // what a hidden value is shown as in a previewed request

export type NotAllowed =
  | "login_or_password" | "file_upload" | "payment" | "captcha" | "bad_action" | "bad_method" | "bad_enctype"
  | "too_many_fields" | "duplicate_names" | "too_large" | "hidden_in_url" | "unusual_path" | "bad_field_name" | "query_on_page" | "bad_hidden_value"
  | "nested_control" | "unknown_control";
// When several apply, the first in this order is the one reported.
const ORDER: NotAllowed[] = ["login_or_password", "captcha", "payment", "file_upload", "nested_control", "unknown_control", "bad_method", "bad_action", "unusual_path", "bad_enctype", "hidden_in_url", "query_on_page", "bad_field_name", "bad_hidden_value", "too_many_fields", "duplicate_names", "too_large"];

export const NOT_ALLOWED_TEXT: Record<NotAllowed, string> = {
  unknown_control: "This form has a field of a kind Tiresias does not know (an input type outside the standard ones), so it does not send the form.",
  nested_control: "This form has a field inside another control (a button, a list of options, a template), which Tiresias cannot list or check as a field, so it does not send the form.",
  login_or_password: "This form asks for sign-in, a password or a login code. Tiresias never handles logins or passwords: a person has to sign in themselves.",
  file_upload: "This form uploads files (a file field or multipart encoding). Tiresias does not send files.",
  payment: "This form looks like a payment or purchase form (a payment action, card number, security code, expiry, IBAN or routing number). This version of Tiresias never pays.",
  captcha: "This form has a CAPTCHA or bot check. A person has to fill it in; Tiresias never solves one.",
  bad_action: "This form sends to something that is not an http or https address, so Tiresias does not use it.",
  bad_method: "This form uses a method other than GET or POST, so Tiresias does not use it.",
  bad_enctype: "This form uses an encoding other than the standard one (application/x-www-form-urlencoded), so Tiresias does not use it.",
  too_many_fields: `This form has more than ${MAX_FIELDS} fields, so Tiresias cannot show it whole and does not send it.`,
  duplicate_names: "Two different fields of this form share one name, so a value could not be matched to one field. Tiresias does not use it.",
  too_large: "This form (its listing, a field name or a default value) is too large to show exactly, so Tiresias does not send it.",
  hidden_in_url: "This GET form has fields the site sets (hidden fields). Sent by GET, their values would sit in the address, and so in replies, history and receipts. Tiresias does not use it.",
  unusual_path: "This form sends to an address whose path is not plain (only letters, digits, _ ~ - and single dots between them are allowed in a path segment), which could reach a different path than it seems. Tiresias does not use it.",
  query_on_page: "This form has no address of its own (no action), so it would send to the page's own address, query included. A query that did not come from the form itself could override the site's values, so Tiresias does not use it. Read the page without a query to use this form.",
  bad_hidden_value: "A field the site sets (a hidden field) has a value that is not plain printable ASCII with no spaces (or is over 4,096 characters). Such a value can be changed on its way back (line breaks, spaces), so Tiresias could not be sure to hide an echo of it. Tiresias does not use this form.",
  bad_field_name: "A field of this form has a name that is not plain (only letters, digits and _ . : - [ ] are allowed, at most 100), so two names could be sent as the same one. Tiresias does not use it.",
};

export type FieldType =
  | "text" | "email" | "search" | "tel" | "url" | "number" | "date" | "datetime-local" | "month" | "week" | "time" | "color" | "range"
  | "textarea" | "select" | "radio" | "checkbox" | "hidden";
const TEXT_TYPES = new Set(["text", "email", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time", "color", "range"]);
const SKIPPED_INPUTS = new Set(["submit", "image", "reset", "button"]); // buttons: their own name and value are never sent

export interface Option {
  value: string;
  label?: string;
  selected?: true; // selected or checked by default
}

// A field as the agent sees it (grouped by name: one radio group, one checkbox group, one select).
export interface PublicField {
  name: string;
  type: FieldType;
  label?: string;
  required?: true;
  readonly?: true;
  multiple?: true; // more than one value may be chosen (a checkbox group, a multiple select)
  maxlength?: number;
  pattern?: string; // shown only: Tiresias never runs a site's pattern
  value?: string; // a text field's default; for a hidden field always "set by the site"
  options?: Option[];
  options_omitted?: number;
}

export interface PublicForm {
  index: number; // 1 = the first form on the page
  method: string; // "GET" or "POST"; anything else as written (lower case, at most 20 characters), with not_allowed
  action: string | null; // the resolved URL the form sends to; null when it is not a usable http(s) URL
  enctype: string;
  not_allowed?: NotAllowed;
  fields: PublicField[];
  fields_omitted?: number;
}

// One control in tree order: this is what the request is built from, so the order matches a browser's.
type Control =
  | { kind: "hidden"; name: string; value: string }
  | { kind: "text"; name: string }
  | { kind: "check"; name: string; value: string }
  | { kind: "radio"; name: string; value: string }
  | { kind: "select"; name: string };

interface Field extends PublicField {
  hiddenField?: true;
  omittedDefault?: true; // a default option was past the listing cap
}

// The whole form, hidden values included. Internal: it never leaves Tiresias and is never cached.
export interface FullForm {
  index: number;
  method: string;
  action: string | null;
  enctype: string;
  not_allowed?: NotAllowed;
  fields: Field[];
  fields_omitted?: number;
  controls: Control[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const jsonBytes = (x: unknown) => bytes(JSON.stringify(x) ?? "");

// ---- reading forms ----

// Text of a node for a label: text nodes only, skipping scripts, styles and form controls, capped.
// One budget is shared by every label on the page, so a page of nested labels cannot make it quadratic.
function textOf(root: N, budget: { left: number }, cap = MAX_LABEL * 2): string {
  let out = "";
  const stack: N[] = [root];
  while (stack.length && out.length < cap && budget.left-- > 0) {
    const n = stack.pop()!;
    if (n.type === "text") out += (n.data ?? "") + " ";
    else if (n.type === "tag" && (n.name === "select" || n.name === "textarea" || n.name === "option" || n.name === "script" || n.name === "style" || n.name === "template")) continue;
    else if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return norm(out);
}

function rawText(root: N): string {
  let out = "";
  const stack: N[] = [root];
  let seen = 0;
  while (stack.length && seen++ < NODE_BUDGET && out.length <= MAX_VALUE * 4) {
    const n = stack.pop()!;
    if (n.type === "text") out += n.data ?? "";
    else if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return out;
}

const cut = (s: string | undefined, n: number): string | undefined => {
  if (s === undefined) return undefined;
  const t = norm(s).slice(0, n);
  return t || undefined;
};

// Characters that render as nothing (zero-width, soft hyphen, bidi marks, variation selectors and the
// like) are removed before any text is judged (round 90).
const invisible = (t: string) => t.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");

// THE text normalization of the form guard (round 93, one path for every text it judges): invisible and
// format characters removed, NFKC (fullwidth letters, ligatures, compatibility digits), case-folded
// (upper then lower, so "ß" is "ss" and the long s is "s"), invisible characters removed again.
const fold = (t: string) => invisible(invisible(t).normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC"));
// The tokens of a text (rounds 93 and 94). CHUNKS: each whitespace-separated piece run together, only
// letters a-z and digits kept ("pass-word", "P.A.S.S.W.O.R.D" and "myPaSsWoRd" give "password",
// "mypassword"); every marker is searched INSIDE these, so capitals and splitting cannot hide one. WORDS:
// the pieces between non-alphanumerics, whole and camelCase split ("SeCuRiTy" gives "security"; "myCard"
// gives "mycard", "my", "card"), for the many-word markers whose words sit apart (round 95: dropping the
// whole words lost "SeCuRiTy" + "code"). Invisible characters are removed FIRST, before capitals
// are looked at (round 94: "my\u200BPassword" hid the boundary).
// The SKELETON of one text (round 95, coordinator's design): normalized like everything else, then every
// character that is not a letter or digit deleted. "SeCuRiTy Code", "S.e.c.u.r.i.t.y Code", "mySeCuRiTy
// Code" and "ArE YoU HuMaN" all contain their marker's run-together form, whatever the spacing,
// punctuation or capitals. Built per attribute value and per block of inline-joined text.
const skeleton = (text: string) => fold(text).replace(/[^a-z0-9]/g, "");
function tokens(text: string): { words: string[]; chunks: string[]; runs: string[][] } {
  const base = invisible(text).normalize("NFKC");
  const folded = fold(base);
  const camel = fold(base.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));
  const runs = [folded, camel].map((s) => s.split(/[^a-z0-9]+/).filter(Boolean));
  return {
    words: runs.flat(),
    chunks: folded.split(/\s+/).map((c) => c.replace(/[^a-z0-9]/g, "")).filter(Boolean),
    runs,
  };
}

// "data" is an <object>'s address (Codex round 79: a CAPTCHA embedded that way was not refused).
const CAPTCHA_ATTRS = ["class", "id", "name", "src", "data", "data-callback"];
// ONE predicate for a challenge's address or name, shared with the wall check (Codex round 80: the
// Cloudflare challenge host was known to the walls but not to the form guard).
export const challengeText = (v: string): boolean => /captcha|turnstile|challenges\.cloudflare\.com/.test(v.toLowerCase());
const EMBEDDED = new Set(["iframe", "frame", "object", "embed"]);
const CONTROLS = new Set(["input", "select", "textarea", "button"]);
const OPAQUE = new Set(["button", "select", "textarea", "template", "script", "style"]); // the field walk does not enter these
// The input types Tiresias knows; any other refuses the form (round 87: it was read as text).
const KNOWN_INPUTS = new Set([...TEXT_TYPES, "hidden", "checkbox", "radio", "submit", "image", "reset", "button", "password", "file"]);
const MAX_AUDIT_TEXT = 1024 * 1024; // all texts the audit reads in one form

// THE form audit (Codex rounds 87 to 91; one pass since the coordinator's decisions of 2026-10-23):
// refuse unless every control is a plain, top-level, recognized field and nothing the form says, or
// anything tied to it says, carries a payment, login or CAPTCHA marker. It is the ONLY place these
// refusals are made; the field walk in readForm only builds the listing.
//
// It checks each element ONCE (round 92: finding the covered roots first, then walking the outermost
// roots' whole subtrees, so no check is ever skipped). The units: the form's enclosing context (each
// ancestor's attributes and references, a wrapping label, the legend of an enclosing fieldset), the form,
// and every element any visited element points to (all labels for its id, aria-labelledby,
// aria-describedby, aria-details, aria-errormessage, aria-owns split on ASCII whitespace, list= as one
// exact id), followed transitively. Every element gets the same checks: elementRefusals, nested_control
// (a control inside a button, select, textarea, template, script or style), unknown_control. Every text it
// reads (every attribute value; each unit's text with text nodes apart, and with inline pieces joined and
// block boundaries kept) has invisible characters removed, is NFKC-normalized, checked for a card number,
// and its words go into ONE word set for the whole form (round 91, Travis's option a). The form is refused
// when every word of any marker in MARKERS is somewhere in that set, in any order. Every limit fails
// closed (too_large): the node budget, MAX_AUDIT_TEXT of text, more than MAX_REFS ids in one reference.
export interface AuditContext {
  ids: Map<string, N>; // every element of the page by id (the first one, as a browser resolves it)
  labelsFor: Map<string, N[]>; // every <label for=...> of the page, all of them per id
  ancestors: N[]; // the form's ancestors, innermost first
  span: Map<N, { a: number; z: number }>; // each node's document-order index and the last index inside it
  texts: Map<string, JudgedText>; // page-local: shared by forms, never by pages or calls
}
// The existing safety markers, single words and phrases alike. A phrase also matches with its words run
// together in any way ("sign in code" is also "signin code", "sign incode" and "signincode").
const MARKER_PHRASES: [NotAllowed, string[]][] = [
  ["payment", ["card number", "card num", "card no", "credit card", "debit card", "cc num", "cc number", "cc exp", "cc expiry", "cc csc", "cc cvv", "cc cvc",
    "cvv", "cvv2", "cvc", "cvc2", "csc", "security code", "expiry", "expiration", "exp date", "exp month", "exp year", "exp mm", "exp yy", "iban", "routing"]],
  ["login_or_password", ["password", "pass code", "passphrase", "login code", "sign in code", "one time", "otp", "verification code", "2fa", "two factor", "authenticator", "pin code"]],
  ["captcha", ["captcha", "turnstile", "not a robot", "not robot", "are you a human", "are you human"]],
];
// Actions use whole words only, never chunks or skeletons: "display", "buyer", "designing" and
// "blog in" are ordinary text. Inflections are explicit so unrelated longer words stay harmless.
const ACTION_WORDS: [NotAllowed, string[]][] = [
  ["payment", ["pay", "pays", "paying", "paid", "payment", "payments", "purchase", "purchases", "purchased", "purchasing", "buy", "buys", "buying", "bought", "checkout", "checkouts", "placeorder"]],
  ["login_or_password", ["login", "logins", "signin", "signins"]],
];
// Preserve the original ASCII-token phrase checks on every text that feeds the word bag,
// including the whole subtree with text nodes spaced apart.
const LEGACY_ACTION_PHRASES: [NotAllowed, string, string][] = [
  ...["check", "checks", "checked", "checking"].map((w): [NotAllowed, string, string] => ["payment", w, "out"]),
  ...["place", "places", "placed", "placing"].flatMap((w) => ["order", "orders"].map((o): [NotAllowed, string, string] => ["payment", w, o])),
  ...["log", "logs", "logged", "logging", "sign", "signs", "signed", "signing"].map((w): [NotAllowed, string, string] => ["login_or_password", w, "in"]),
];
// New phrases require ordered Unicode words in one attribute or block, in either inline
// tokenisation. Separate attributes or blocks cannot form a new phrase.
const ACTION_PHRASES: [NotAllowed, string, string][] = [
  ...LEGACY_ACTION_PHRASES,
  ...["confirm", "confirms", "confirmed", "confirming", "complete", "completes", "completed", "completing",
    "submit", "submits", "submitted", "submitting", "finish", "finishes", "finished", "finishing",
    "finalize", "finalizes", "finalized", "finalizing", "finalise", "finalises", "finalised", "finalising"]
    .flatMap((w) => ["order", "orders", "purchase", "purchases", "payment", "payments"].map((o): [NotAllowed, string, string] => ["payment", w, o])),
  ["payment", "order", "now"],
];
// Script selects candidate lists, not a language identification. Only unambiguous vocabulary
// matches anywhere. Ambiguous bare words require a complete submit-control text/value/alt,
// optionally preceded or followed by that language's "now", with closed complements.
// Explicit inflections only, no stemming.
type ActionGroups = [login: string[], payment: string[]];
interface OtherActions { anywhere: ActionGroups; submit: ActionGroups; now: string[] }
// Closed, language-specific grammar; at most two of these may separate phrase parts.
const FILLERS: Record<string, string[]> = {
  en: ["your", "my", "the", "this", "our", "their", "me"],
  es: ["mi", "tu", "su", "el", "la", "los", "las", "mis", "tus", "sus", "este", "esta"],
  fr: ["ma", "mon", "mes", "votre", "vos", "notre", "nos", "la", "le", "les", "ce", "cette"],
  de: ["meine", "meinen", "mein", "ihre", "ihren", "ihr", "die", "der", "das", "deine", "deinen", "dein"],
  pt: ["meu", "minha", "seu", "sua", "o", "a", "os", "as", "este", "esta"],
  it: ["mio", "mia", "tuo", "tua", "suo", "sua", "il", "lo", "la", "un", "una"],
  nl: ["mijn", "je", "jouw", "uw", "de", "het", "dit", "deze"],
  ru: ["мой", "моя", "мои", "мою", "ваш", "ваша", "ваши", "вашу", "свой", "свою", "этот"],
  zh: ["我的", "您的", "你的"], ja: ["私の", "あなたの"], ko: ["내", "나의", "귀하의"],
  ar: ["هذا", "هذه"], hi: ["मेरा", "मेरे", "अपना", "अपने", "आपका", "आपके", "की"],
};
// Only complete control labels accept these complements, never arbitrary trailing text.
const COMPLEMENTS: Record<string, ActionGroups> = {
  en: [["with email", "to account"], []], es: [["con email", "con correo", "a cuenta"], []],
  fr: [["avec email", "par email", "a compte"], ["par carte"]],
  de: [["mit email", "mit e mail", "in konto"], []], pt: [["com email", "com e mail", "na conta"], []],
  it: [["con email", "con e mail", "al account"], []], nl: [["met email", "met e mail", "op account"], []],
  ru: [["по почте", "в аккаунт"], []], ar: [["إلى حسابك", "الى حسابك", "بالبريد"], []],
};
const OTHER_ACTIONS: Record<Lang, OtherActions> = {
  en: { anywhere: [[], []], submit: [["log in", "sign in"], ["order"]], now: ["now"] },
  es: { anywhere: [["iniciar sesion", "inicia sesion", "inicie sesion"],
    ["pagar", "pague", "comprar", "finalizar compra", "finalizar pedido", "realizar pedido", "hacer pedido", "confirmar pedido", "tramitar pedido"]],
    submit: [["acceder", "accede", "acceda"], ["paga", "compra", "compre"]], now: ["ahora"] },
  fr: { anywhere: [["se connecter", "me connecter", "connectez vous", "ouvrir une session"],
    ["payez", "acheter", "achetez", "passer a la caisse", "passer commande", "valider la commande", "confirmer la commande"]],
    submit: [["connexion"], ["payer", "achat", "commander"]], now: ["maintenant"] },
  de: { anywhere: [["einloggen", "einloggen sie sich"],
    ["bezahlen", "kaufen", "kaufe", "zur kasse", "bestellung aufgeben", "jetzt bestellen", "bestellung bestatigen"]],
    submit: [["anmelden", "anmeldung"], ["zahlen", "kauf", "bestellen", "zahlungspflichtig bestellen"]], now: ["jetzt"] },
  pt: { anywhere: [["iniciar sessao", "iniciar sessao de utilizador", "fazer login", "entrar na conta"],
    ["pagar", "pague", "comprar", "finalizar compra", "finalizar pedido", "fazer pedido", "efetuar pedido", "confirmar pedido", "concluir pedido"]],
    submit: [["entrar"], ["compre", "compra"]], now: ["agora"] },
  it: { anywhere: [["effettua l accesso", "inizia sessione"],
    ["pagare", "acquista", "acquistare", "acquisto", "comprare", "procedi al pagamento", "vai alla cassa", "effettua ordine", "effettua l ordine", "conferma ordine"]],
    submit: [["accedi", "accedere"], ["paga", "compra", "ordina"]], now: ["ora", "adesso"] },
  nl: { anywhere: [["inloggen", "log in", "meld je aan"],
    ["betalen", "betaal", "kopen", "aankoop", "afrekenen", "bestelling plaatsen", "plaats bestelling", "bestelling bevestigen"]],
    submit: [["aanmelden", "aanmelding"], ["koop", "bestel"]], now: ["nu"] },
  ru: { anywhere: [["вход в систему", "авторизоваться"],
    ["оплатить", "оплата", "платить", "купить", "покупка", "оформить покупку", "оформить заказ", "разместить заказ", "подтвердить заказ", "заказать"]],
    submit: [["войти", "вход"], ["приобрести"]], now: ["сейчас"] },
  zh: { anywhere: [["登录", "登錄", "登入"],
    ["支付", "付款", "购买", "購買", "结账", "結帳", "結賬", "结算", "結算", "下单", "下單", "提交订单", "提交訂單", "确认订单", "確認訂單"]],
    submit: [[], ["买", "買", "订购", "訂購"]], now: ["现在", "現在", "立即"] },
  ja: { anywhere: [["ログイン", "サインイン"],
    ["支払う", "支払い", "お支払", "購入", "買う", "チェックアウト", "レジに進む", "注文する", "注文を確定", "注文を送信", "注文確定", "注文を完了する"]],
    submit: [[], []], now: ["今すぐ"] },
  ko: { anywhere: [["로그인", "로그인하기"],
    ["결제", "지불", "구매", "구입", "체크아웃", "주문하기", "주문 제출", "주문 확정", "주문 완료"]],
    submit: [[], ["사기"]], now: ["지금"] },
  ar: { anywhere: [["تسجيل الدخول", "تسجيل دخول"],
    ["ادفع", "إدفع", "شراء", "اشتر", "اشتري", "اشترى", "إتمام الشراء", "اتمام الشراء", "تقديم الطلب", "إرسال الطلب", "ارسال الطلب", "تأكيد الطلب"]],
    submit: [["الدخول"], ["دفع", "الدفع", "اطلب"]], now: ["الآن", "الان"] },
  hi: { anywhere: [["साइन इन", "लॉग इन", "लाग इन", "लॉगिन", "प्रवेश करें"],
    ["भुगतान", "खरीदें", "खरीदना", "खरीदारी", "चेकआउट", "चेक आउट", "ऑर्डर दें", "आर्डर दें", "ऑर्डर करें", "ऑर्डर पक्का करें", "ऑर्डर पुष्टि करें"]],
    submit: [[], []], now: ["अभी"] },
};
const NO_ACTION_EDGES = new Set(["zh", "ja", "ko"]);
const LATIN_ACTIONS = new Set(["es", "fr", "de", "pt", "it", "nl"]);
const WORD_SEP = "[^\\p{L}\\p{M}\\p{N}]+";
const actionBody = (phrase: string, language?: string) => {
  const fillers = language ? FILLERS[language] : undefined;
  const sep = fillers?.length ? `${WORD_SEP}(?:(?:${fillers.join("|")})${WORD_SEP}){0,2}` : WORD_SEP;
  const words = fold(phrase).split(" ");
  // Existing phrases include determiners ("confirmer la commande"). Treat those
  // as fillers too, so the same zero-to-two bound applies to every spelling.
  return words.filter((w, i) => i === 0 || i === words.length - 1 || !fillers?.includes(w)).join(sep);
};
const actionPattern = (language: string, phrase: string) => {
  const body = actionBody(phrase, language);
  return new RegExp(NO_ACTION_EDGES.has(language) ? body : `(?<![\\p{L}\\p{M}\\p{N}])${body}(?![\\p{L}\\p{M}\\p{N}])`, "u");
};
const OTHER_ACTION_PATTERNS = new Map(Object.entries(OTHER_ACTIONS).map(([language, { anywhere, submit, now }]) => {
  const sep = NO_ACTION_EDGES.has(language) ? "\\s*" : WORD_SEP;
  const when = now.map(w => actionBody(w)).join("|");
  return [language, {
    anywhere: anywhere.map((phrases) => phrases.map((p) => actionPattern(language, p))),
    submit: submit.map((words, group) => words.map((w) => {
      const complement = (COMPLEMENTS[language]?.[group] ?? []).map(p => actionBody(p, language)).join("|");
      const action = `${actionBody(w)}${complement ? `(?:${sep}(?:${complement}))?` : ""}`;
      return new RegExp(`^(?:(?:${when})${sep})?${action}(?:${sep}(?:${when}))?$`, "u");
    })),
  }];
}));
// One first-word lookup per token; each candidate has a constant, bounded gap.
function phraseIndex(phrases: [NotAllowed, string, string][]) {
  const index = new Map<string, Map<string, NotAllowed>>();
  for (const [code, first, second] of phrases) {
    if (!index.has(first)) index.set(first, new Map());
    index.get(first)!.set(second, code);
  }
  return index;
}
const LEGACY_INDEX = phraseIndex(LEGACY_ACTION_PHRASES);
const ACTION_INDEX = phraseIndex(ACTION_PHRASES);
const EN_FILLERS = new Set(FILLERS.en);
function phraseRefusals(run: string[], index: Map<string, Map<string, NotAllowed>>, b: { np(x: NotAllowed): void }, gaps = false) {
  for (let i = 0; i + 1 < run.length; i++) {
    const ends = index.get(run[i]);
    if (!ends) continue;
    for (let j = i + 1; j < run.length && j <= i + (gaps ? 3 : 1); j++) {
      const code = ends.get(run[j]);
      if (code) b.np(code);
      if (!EN_FILLERS.has(run[j])) break;
    }
  }
}

function otherActionRefusals(text: string, b: { np(x: NotAllowed): void }, submit = false): void {
  const folded = norm(fold(text));
  for (const language of ["en", ...listsFor(folded)]) {
    const value = LATIN_ACTIONS.has(language) ? stripAccents(folded) : folded;
    const patterns = OTHER_ACTION_PATTERNS.get(language)!;
    const groups = submit ? patterns.submit : patterns.anywhere;
    if (groups[0].some((re) => re.test(value))) b.np("login_or_password");
    if (groups[1].some((re) => re.test(value))) b.np("payment");
  }
}

function actionRefusals(text: string, b: { np(x: NotAllowed): void }): void {
  const base = invisible(text).normalize("NFKC");
  const runs = [fold(base), fold(base.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"))]
    .map((s) => s.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean));
  for (const run of runs) {
    phraseRefusals(run, ACTION_INDEX, b, true);
  }
  otherActionRefusals(text, b);
}
// Every marker's run-together form, searched inside every chunk (round 94, coordinator's decision): a
// marker anywhere inside a word counts ("recaptcha", "mypassword", "footpath" for "otp").
// Markers whose run-together form has SHORT_MARKER characters or more are found inside skeletons (across
// spaces and punctuation; by the MARKERS check at the end, whose fully joined variant of each phrase is its
// run-together form); shorter ones (cvv, otp, csc, iban, 2fa...) only inside chunks, here, so "top tip" is
// not "otp" (fewer harmless refusals).
export const SHORT_MARKER = 5;
const MARKER_INSIDE: [NotAllowed, string][] = MARKER_PHRASES.flatMap(([code, ps]) => ps.map((p): [NotAllowed, string] => [code, p.replace(/ /g, "")]));
const MARKER_SHORT = MARKER_INSIDE.filter(([, m]) => m.length < SHORT_MARKER);
const joinings = (ws: string[]): string[][] => {
  if (ws.length === 1) return [ws];
  const out: string[][] = [];
  for (const rest of joinings(ws.slice(1))) out.push([ws[0], ...rest], [ws[0] + rest[0], ...rest.slice(1)]);
  return out;
};
// The many-word markers with their words apart, checked against the form's word set in any order; a
// phrase also matches with some of its words run together ("signin" + "code").
const MARKERS: [NotAllowed, string[]][] = MARKER_PHRASES.flatMap(([code, ps]) =>
  ps.flatMap((p) => joinings(p.split(" ")).map((w): [NotAllowed, string[]] => [code, w])),
);
const ID_LISTS = ["aria-labelledby", "aria-describedby", "aria-details", "aria-errormessage", "aria-owns"];
const MAX_REFS = 50; // ids in one reference attribute, and labels for one id; more refuses (round 89)
// Elements that break a line of text. Anything else (custom elements included) is inline, as in a browser.
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "button", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "input", "legend", "li", "main", "menu", "nav", "ol",
  "optgroup", "option", "p", "pre", "section", "select", "summary", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "tr", "ul",
]);
interface JudgedText {
  words: string[]; skeleton: string; card: boolean;
  basic: Set<NotAllowed>; actions: Set<NotAllowed>; submit: Set<NotAllowed>;
}
function judgeText(text: string, cache: Map<string, JudgedText>): JudgedText {
  const old = cache.get(text);
  if (old) return old;
  const { words, chunks, runs } = tokens(text);
  const basic = new Set<NotAllowed>(), actions = new Set<NotAllowed>(), submit = new Set<NotAllowed>();
  for (const run of runs) phraseRefusals(run, LEGACY_INDEX, { np: c => basic.add(c) });
  for (const c of new Set(chunks)) for (const [code, inside] of MARKER_SHORT) if (c.includes(inside)) basic.add(code);
  actionRefusals(text, { np: c => actions.add(c) });
  otherActionRefusals(text, { np: c => submit.add(c) }, true);
  const value = { words: [...new Set(words)], skeleton: skeleton(text), card: hasCardNumber(text), basic, actions, submit };
  cache.set(text, value);
  return value;
}
function auditForm(form: N, b: { np(x: NotAllowed): void }, ctx: AuditContext): void {
  let used = 0;
  let nodes = 0;
  let stop = false;
  const tooLarge = () => {
    stop = true;
    b.np("too_large");
  };
  const bag = new Set<string>(); // every word the form and everything tied to it says
  const skeletons = new Set<string>();
  // Charge every read even on a cache hit: sharing classification never grants extra budget.
  const charged = (text: string) => {
    used += text.length;
    if (used > MAX_AUDIT_TEXT) { tooLarge(); return undefined; }
    return judgeText(text, ctx.texts);
  };
  const judge = (text: string, skel: boolean) => {
    const value = charged(text);
    if (!value) return;
    for (const w of value.words) bag.add(w);
    for (const c of value.basic) b.np(c);
    if (!skel) return;
    for (const c of value.actions) b.np(c);
    if (value.card) b.np("payment");
    skeletons.add(value.skeleton);
  };
  const submitText = (text: string) => {
    const value = charged(text);
    if (value) for (const c of value.submit) b.np(c);
  };
  // each attribute value is its own text (round 93: never joined); each element's attributes are judged
  // exactly once, whether reached as an ancestor or in a walk (round 96: twice spent the budget twice)
  const attrSeen = new Set<N>();
  const attrs = (n: N) => {
    if (attrSeen.has(n)) return;
    attrSeen.add(n);
    const c = n.attribs ?? {};
    for (const v of Object.values(c)) judge(v, true);
    if (n.name === "input" && ["submit", "button", "image"].includes((c.type ?? "").trim().toLowerCase())) {
      for (const v of [c.value, c.alt]) if (v !== undefined) submitText(v);
    }
  };
  const units: N[] = [];
  const queued = new Set<N>();
  const unit = (n: N | undefined) => {
    if (n && !queued.has(n)) {
      queued.add(n);
      units.push(n);
    }
  };
  // what one element points to, queued as units
  const follow = (c: Record<string, string>) => {
    if (c.id) {
      const ls = ctx.labelsFor.get(c.id) ?? [];
      if (ls.length > MAX_REFS) tooLarge();
      else ls.forEach((l) => unit(l));
    }
    for (const k of ID_LISTS) {
      // an id list splits on ASCII whitespace only, as HTML does (round 90: U+00A0 can be part of an id)
      const refs = (c[k] ?? "").split(/[\t\n\f\r ]+/).filter(Boolean);
      if (refs.length > MAX_REFS) tooLarge();
      else for (const id of refs) unit(ctx.ids.get(id));
    }
    if (c.list) unit(ctx.ids.get(c.list)); // list= is one exact id
  };
  const isTag = (x: N) => x.type === "tag" || x.type === "script" || x.type === "style";

  // the enclosing context
  for (const an of ctx.ancestors) {
    if (!isTag(an)) continue;
    const nm = (an.name ?? "").toLowerCase();
    const c = an.attribs ?? {};
    if (OPAQUE.has(nm)) b.np("nested_control");
    elementRefusals(nm, c, b);
    attrs(an);
    follow(c);
    if (nm === "label") unit(an);
    if (nm === "fieldset") for (const ch of an.children ?? []) if (isTag(ch) && (ch.name ?? "").toLowerCase() === "legend") unit(ch);
  }
  unit(form);
  // Round 92 (coordinator's shape): visiting once may only skip duplicate WORK, never a check. So:
  // 1. Find every covered root: one pass over the union of the roots' subtrees, following references
  //    (each node at most once; it makes no checks).
  // 2. Keep the outermost roots (a root inside another root's subtree is dropped), by document-order
  //    spans, and walk each one's WHOLE subtree, making every check on every node. The kept subtrees are
  //    disjoint, so every node of the union is checked exactly once, with its true nesting inside its
  //    root and its text next to its neighbours. Both passes are linear in the union.
  const seen = new Set<N>();
  for (let u = 0; u < units.length && !stop; u++) {
    const work: N[] = [units[u]];
    while (work.length && !stop) {
      const x = work.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (++nodes > NODE_BUDGET) return tooLarge();
      if (isTag(x)) follow(x.attribs ?? {});
      for (const ch of x.children ?? []) work.push(ch);
    }
  }
  if (stop) return;
  if (units.some((r) => !ctx.span.has(r))) return tooLarge(); // a root the page walk never placed: refused
  const where = (n: N) => ctx.span.get(n)!;
  const roots: N[] = [];
  let end = -1;
  for (const r of [...units].sort((p, q) => where(p).a - where(q).a)) {
    const w = where(r);
    if (w.a <= end) continue; // inside the last kept root (spans nest or are apart)
    roots.push(r);
    end = Math.max(end, w.z);
  }
  type Item = { n: N; inside: boolean } | { sep: true } | { buttonEnd: true };
  for (const root of roots) {
    let spaced = "";
    // blocks of inline-joined text, as STRUCTURE (round 96: a "\n" marker was confused with a line break
    // in the page's own text, which split a word or a card number)
    const blocks: { joined: string; spaced: string }[] = [];
    let cur = "";
    let curSpaced = "";
    let buttonText: { joined: string; spaced: string } | undefined;
    let size = 0;
    const endBlock = () => {
      if (cur) blocks.push({ joined: cur, spaced: curSpaced });
      cur = "";
      curSpaced = "";
    };
    const work: Item[] = [{ n: root, inside: false }];
    while (work.length && !stop) {
      const it = work.pop()!;
      if ("buttonEnd" in it) {
        submitText(buttonText!.joined);
        submitText(buttonText!.spaced);
        buttonText = undefined;
        continue;
      }
      if ("sep" in it) {
        endBlock();
        continue;
      }
      const { n: x, inside } = it; // the kept subtrees are the union found above, so no new budget is needed
      if (x.type === "text") {
        if (charged(x.data ?? "")?.card) b.np("payment");
        spaced += (x.data ?? "") + " ";
        cur += x.data ?? "";
        curSpaced += (x.data ?? "") + " ";
        if (buttonText) {
          buttonText.joined += x.data ?? "";
          buttonText.spaced += (x.data ?? "") + " ";
        }
        size += (x.data ?? "").length;
        if (spaced.length + size > MAX_AUDIT_TEXT) return tooLarge();
        continue;
      }
      let into = inside;
      let block = false;
      if (isTag(x)) {
        const nm = (x.name ?? "").toLowerCase();
        const c = x.attribs ?? {};
        elementRefusals(nm, c, b);
        if (inside && CONTROLS.has(nm)) b.np("nested_control");
        if (OPAQUE.has(nm)) into = true;
        if (nm === "input" && !KNOWN_INPUTS.has((c.type ?? "text").trim().toLowerCase())) b.np("unknown_control");
        attrs(x); // every attribute value: titles, labels, placeholders, values...
        block = BLOCK.has(nm);
        // Capture a button's entire text in the same bounded walk. Nested controls already
        // fail closed; do not copy their text into multiple nested accumulators.
        if (nm === "button" && !buttonText) {
          buttonText = { joined: "", spaced: "" };
          work.push({ buttonEnd: true });
        }
      }
      if (block) {
        endBlock();
        work.push({ sep: true });
      }
      const ch = x.children ?? [];
      for (let k = ch.length - 1; k >= 0; k--) work.push({ n: ch[k], inside: into });
    }
    if (stop) return;
    endBlock();
    judge(spaced, false);
    // each block of inline-joined text is one text: its skeleton and its card digits (round 95: a card
    // number split across inline elements). Any white space in a block, line breaks, tabs and CR included,
    // is ordinary spacing (round 96).
    for (const piece of blocks) {
      judge(piece.joined.replace(/\s+/g, " "), true);
      if (piece.spaced !== piece.joined) {
        const value = charged(piece.spaced);
        if (value) for (const c of value.actions) b.np(c);
      }
    }
  }
  if (stop) return;
  // EVERY marker of SHORT_MARKER characters or more, and every many-word marker with its words apart: a word
  // (or run-together piece) of SHORT_MARKER letters or more counts when it is inside any skeleton
  // ("SeCuRiTy Code" as "securitycode"; "mySeCuRiTy" and "code"), a shorter one only as a whole word
  const all = [...skeletons].join("|");
  const has = (w: string) => bag.has(w) || (w.length >= SHORT_MARKER && all.includes(w));
  for (const [code, need] of MARKERS) if (need.every(has)) b.np(code);
  for (const [code, words] of ACTION_WORDS) if (words.some((w) => bag.has(w))) b.np(code);
}

// ONE set of per-element refusals (Codex round 85: the whole-form scan had its own, shorter copy). Used by
// the whole-form scan, which visits every element, and by the field walk. Label-based payment checks stay
// in the field walk, where labels are known; they only add refusals.
function elementRefusals(name: string, c: Record<string, string>, b: { np(x: NotAllowed): void }): void {
  if (captchaMarker(c) || EMBEDDED.has(name)) b.np("captcha");
  const auto = (c.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (auto.some((x) => x === "username" || x === "current-password" || x === "new-password" || x === "one-time-code")) b.np("login_or_password");
  if (auto.some((x) => x.startsWith("cc-"))) b.np("payment");
  if (name === "input") {
    const type = (c.type ?? "text").trim().toLowerCase();
    if (type === "password") b.np("login_or_password");
    if (type === "file") b.np("file_upload");
  }
}
function captchaMarker(a: Record<string, string>): boolean {
  if ("data-sitekey" in a) return true;
  for (const k of CAPTCHA_ATTRS) if (challengeText(a[k] ?? "")) return true;
  return false;
}

// W-04 (Codex round 53, replacing the deny-lists of rounds 51 and 52): a path is ALLOWED only when it is
// segments of letters, digits, "_", "~" and "-", with single dots only between them, and at most one
// trailing slash. So no "%", no ".." or "." segment, no ";" path parameter, no backslash, no other
// punctuation, no empty segment. Checked on the path as written and on the parsed URL; both must pass.
// The query is not affected. Known cost: some legitimate paths cannot be submitted to.
export const PATH_RE = /^(\/[A-Za-z0-9_~-]+(\.[A-Za-z0-9_~-]+)*)*\/?$/;
const MAX_PATH_CHECK = 8192;
// The path AS WRITTEN in `raw` (absolute, or relative). A relative path without a leading "/" is checked
// with one put in front ("send" as "/send"), which keeps every character rule. Callers check the parsed
// URL as well (the resolved action; a slip's target pathname): both must pass.
export function pathAllowed(raw: string): boolean {
  if (raw.length > MAX_PATH_CHECK) return false;
  const pre = raw.split(/[?#]/)[0];
  let written = /^[a-z][a-z0-9+.-]*:/i.test(pre) ? pre.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") : pre.startsWith("//") ? pre.replace(/^\/\/[^/]*/, "") : pre;
  if (written !== "" && !written.startsWith("/")) written = "/" + written;
  return PATH_RE.test(written);
}

// W-04 (Codex round 53): every field name must be plain, exactly as decoded from the HTML, so two names
// that look different can never encode to the same bytes (a hidden "role\nx" and a visible "role\rx" both
// encoded as role%0D%0Ax). A form with any other name is not_allowed "bad_field_name".
export const FIELD_NAME_RE = /^[A-Za-z0-9_.:\-\[\]]{1,100}$/;

// Codex round 54: the collision rule compares names in a canonical form, because servers rename them
// (PHP turns "." and " " into "_", "[" starts an array, some frameworks ignore case). Lower case, then
// ".", " ", "[", "]" and "-" become "_". Two different fields (visible or hidden), or a field and a name
// in a POST target's own query, that are equal this way make the form duplicate_names.
// Codex round 56: a hidden value must be printable ASCII with no whitespace or control characters, as
// decoded from the HTML, so nothing on its way to the site and back can change it except the encodings
// that are masked (form-urlencoded, percent-encoded, HTML-escaped).
export const HIDDEN_VALUE_RE = /^[\x21-\x7E]{0,4096}$/;

export const canonicalName = (n: string): string => n.toLowerCase().replace(/[. \[\]-]/g, "_");

// Codex round 52: a run of 13 to 19 digits, optionally separated by single spaces or dashes, that passes
// Luhn, anywhere in a value, looks like a card number. Runs are maximal (bounded by anything that is not
// a digit or a single separator between digits).
const RUN = /\d(?:[\s\p{Pd}]?\d)*/gu;
// A card number: 13 to 19 digits passing the Luhn check, possibly split by single spaces or dashes of any
// kind. The text is normalized first (fullwidth digits, invisible characters; round 93).
export function hasCardNumber(v: string | undefined): boolean {
  if (!v) return false;
  for (const m of fold(v).matchAll(RUN)) {
    const d = m[0].replace(/[\s\p{Pd}]/gu, "");
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let x = d.charCodeAt(d.length - 1 - i) - 48;
      if (i % 2 === 1) (x *= 2), x > 9 && (x -= 9);
      sum += x;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function resolveAction(raw: string | undefined, pageUrl: string, base: string): string | null {
  try {
    // A missing or empty action sends to the page itself; otherwise it is resolved against <base href>.
    const u = raw === undefined || raw.trim() === "" ? new URL(pageUrl) : new URL(raw.trim(), base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    u.hash = "";
    return u.href.length > MAX_URL ? null : u.href;
  } catch {
    return null;
  }
}

class FormBuilder {
  fields = new Map<string, Field>(); // key: "h:" + name for hidden fields, "v:" + name for the rest
  controls: Control[] = [];
  flags = new Set<NotAllowed>();
  constructor(public index: number) {}
  np(code: NotAllowed) {
    this.flags.add(code);
  }
  visible(name: string, type: FieldType, make: () => Field): Field | null {
    const key = "v:" + name;
    const f = this.fields.get(key);
    if (!f) {
      const nf = make();
      this.fields.set(key, nf);
      return nf;
    }
    // Only radio buttons, and checkboxes, may share a name (one group). Anything else is ambiguous.
    if ((type === "radio" || type === "checkbox") && f.type === type) return f;
    this.np("duplicate_names");
    return null;
  }
  addOption(f: Field, o: Option) {
    f.options ??= [];
    if (f.options.some((x) => x.value === o.value)) {
      if (o.selected && !f.options.find((x) => x.value === o.value)!.selected) f.options.find((x) => x.value === o.value)!.selected = true;
      return;
    }
    if (f.options.length >= MAX_OPTIONS || o.value.length > MAX_OPTION_VALUE) {
      f.options_omitted = (f.options_omitted ?? 0) + 1;
      if (o.selected) f.omittedDefault = true;
      return;
    }
    f.options.push(o);
  }
}

// Every <form> on the page, in order, with its fields. A form nested in another (invalid HTML) is
// read as part of the outer one, as browsers do. Fields linked from outside a form with form="id"
// are not included.
export function extractForms(doc: N, pageUrl: string, flattened = false): { forms: FullForm[]; omitted: number } {
  const budget = { left: TEXT_BUDGET };
  let base = pageUrl;
  let baseSeen = false;
  const labelFor = new Map<string, N>();
  const formNodes: N[] = [];
  const ids = new Map<string, N>(); // every element by id, for the audit
  const labelsFor = new Map<string, N[]>(); // every label for= of the page, for the audit
  type Up = { n: N; up: Up | null } | null; // ancestor chain, innermost first
  const formUp = new Map<N, Up>();
  // each node's place in document order: its own index and the last index inside it (round 92: the audit
  // tells which covered elements contain which, in linear time). A node left open at the budget contains
  // everything after it.
  const span = new Map<N, { a: number; z: number }>();
  let clock = 0;
  const stack: ({ n: N; inForm: boolean; up: Up } | { close: N })[] = [{ n: doc, inForm: false, up: null }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if ("close" in item) {
      span.get(item.close)!.z = clock - 1;
      continue;
    }
    const { n, inForm, up } = item;
    if (++count > NODE_BUDGET) break; // forms past the budget are never found, so never sent
    span.set(n, { a: clock++, z: Number.MAX_SAFE_INTEGER });
    stack.push({ close: n });
    let inside = inForm;
    if (n.type === "tag") {
      const a = n.attribs ?? {};
      if (n.name === "base" && !baseSeen && a.href !== undefined) {
        baseSeen = true;
        try {
          const b = new URL(a.href.trim(), pageUrl);
          if (b.protocol === "http:" || b.protocol === "https:") base = b.href;
        } catch {
          // a bad base is ignored
        }
      }
      if (n.name === "label" && a.for && !labelFor.has(a.for)) labelFor.set(a.for, n);
      if (n.name === "label" && a.for) labelsFor.set(a.for, [...(labelsFor.get(a.for) ?? []), n].slice(0, MAX_REFS + 1));
      if (n.name === "form" && !inForm) {
        formNodes.push(n);
        formUp.set(n, up);
        inside = true;
      }
    }
    // every element by id, script and style included (round 90: they are elements the audit checks too)
    if ((n.type === "tag" || n.type === "script" || n.type === "style") && n.attribs?.id && !ids.has(n.attribs.id)) ids.set(n.attribs.id, n);
    const next: Up = { n, up };
    if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push({ n: n.children[i], inForm: inside, up: next });
  }
  const labelCache = new Map<N, string>();
  const labelText = (n: N) => {
    let t = labelCache.get(n);
    if (t === undefined) labelCache.set(n, (t = textOf(n, budget)));
    return t;
  };
  const texts = new Map<string, JudgedText>();
  const forms = formNodes.slice(0, MAX_FORMS).map((f, i) => {
    const ancestors: N[] = [];
    for (let x = formUp.get(f) ?? null; x; x = x.up) ancestors.push(x.n);
    const form = readForm(f, i + 1, pageUrl, base, labelFor, labelText, budget, { ids, labelsFor, ancestors, span, texts });
    // Flattening may have changed a control's owner or its ancestors: never submit a partial form.
    if (flattened && !form.not_allowed) form.not_allowed = "too_large";
    return form;
  });
  return { forms, omitted: Math.max(0, formNodes.length - MAX_FORMS) };
}

function readForm(
  form: N, index: number, pageUrl: string, base: string, labelFor: Map<string, N>, labelText: (n: N) => string, budget: { left: number }, audit: AuditContext,
): FullForm {
  const a = form.attribs ?? {};
  const b = new FormBuilder(index);
  const rawMethod = (a.method ?? "").trim().toLowerCase();
  const method = rawMethod === "" || rawMethod === "get" ? "GET" : rawMethod === "post" ? "POST" : rawMethod.slice(0, 20);
  if (method !== "GET" && method !== "POST") b.np("bad_method");
  const enctype = (a.enctype ?? "").trim().toLowerCase().slice(0, 100) || "application/x-www-form-urlencoded";
  if (enctype === "multipart/form-data") b.np("file_upload");
  else if (method === "POST" && enctype !== "application/x-www-form-urlencoded") b.np("bad_enctype"); // GET always encodes the query this way
  const action = resolveAction(a.action, pageUrl, base);
  if (action === null) b.np("bad_action");
  // Codex round 53: the action as written and the resolved URL's path must both be plain.
  else if (!PATH_RE.test(new URL(action).pathname) || (a.action !== undefined && a.action.trim() !== "" && !pathAllowed(a.action.trim()))) b.np("unusual_path");
  // THE audit makes every payment, login, CAPTCHA, nested and unknown-control refusal (one path).
  auditForm(form, b, audit);

  const labelOf = (c: Record<string, string>, ctxLabel: N | null): string | undefined => {
    const id = c.id;
    const t = id && labelFor.has(id) ? labelText(labelFor.get(id)!) : ctxLabel ? labelText(ctxLabel) : "";
    return cut(t || c["aria-label"] || c.placeholder || c.title, MAX_LABEL);
  };
  const intAttr = (v: string | undefined) => (v !== undefined && /^\s*\d{1,7}\s*$/.test(v) ? Number(v) : undefined);

  type Ctx = { n: N; label: N | null; disabled: boolean; legend?: string };
  const stack: Ctx[] = (form.children ?? []).slice().reverse().map((n) => ({ n, label: null, disabled: false }));
  let count = 0;
  while (stack.length) {
    const t = stack.pop()!;
    if (++count > NODE_BUDGET) {
      b.np("too_large"); // a form too large to check whole is never sent (fail closed: round 81)
      break;
    }
    const n = t.n;
    if (n.type !== "tag" && n.type !== "script") {
      if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push({ ...t, n: n.children[i] });
      continue;
    }
    const c = n.attribs ?? {};
    const name = n.name ?? "";
    let { label, disabled, legend } = t;
    if (name === "label") label = n;
    if (name === "fieldset") {
      if ("disabled" in c) disabled = true;
      const lg = (n.children ?? []).find((x) => x.type === "tag" && x.name === "legend");
      legend = lg ? cut(textOf(lg, budget), MAX_LABEL) : undefined;
    }
    if ((name === "input" || name === "textarea" || name === "select") && c.name !== undefined && c.name !== "" && !FIELD_NAME_RE.test(c.name)) b.np("bad_field_name");
    if (name === "input") {
      const type = (c.type ?? "text").trim().toLowerCase();
      const fname = c.name;
      if (SKIPPED_INPUTS.has(type) || type === "password" || type === "file" || disabled || "disabled" in c || !fname) continue;
      if (fname.length > MAX_NAME) {
        b.np("too_large");
        continue;
      }
      if (type === "hidden") {
        if (method === "GET") b.np("hidden_in_url"); // its value would sit in the address (Codex round 51)
        if (!HIDDEN_VALUE_RE.test(c.value ?? "")) b.np("bad_hidden_value"); // allow-list (Codex round 56)
        b.controls.push({ kind: "hidden", name: fname, value: c.value ?? "" });
        if (!b.fields.has("h:" + fname)) b.fields.set("h:" + fname, { name: fname, type: "hidden", value: HIDDEN_VALUE, hiddenField: true });
        continue;
      }
      const lbl = labelOf(c, label);
      if (type === "radio" || type === "checkbox") {
        const value = c.value ?? "on";
        const f = b.visible(fname, type, () => ({ name: fname, type, ...(type === "checkbox" ? { multiple: true as const } : {}) }));
        if (!f) continue;
        if ("required" in c) f.required = true;
        b.addOption(f, { value, ...(lbl ? { label: cut(lbl, MAX_OPTION_LABEL) } : {}), ...("checked" in c ? { selected: true as const } : {}) });
        if (!f.label) f.label = legend ?? undefined;
        b.controls.push({ kind: type === "radio" ? "radio" : "check", name: fname, value });
        continue;
      }
      const ftype = (TEXT_TYPES.has(type) ? type : "text") as FieldType;
      const def = (c.value ?? "").replace(/[\r\n]/g, ""); // a browser strips line breaks from an input's value
      if (bytes(def) > MAX_VALUE) b.np("too_large");
      const f = b.visible(fname, ftype, () => ({
        name: fname, type: ftype, ...(lbl ? { label: lbl } : {}), ...("required" in c ? { required: true as const } : {}), ...("readonly" in c ? { readonly: true as const } : {}),
        ...(intAttr(c.maxlength) !== undefined ? { maxlength: intAttr(c.maxlength) } : {}),
        ...(c.pattern !== undefined && c.pattern.length <= MAX_PATTERN ? { pattern: c.pattern } : {}),
        value: def,
      }));
      if (f) b.controls.push({ kind: "text", name: fname });
      continue;
    }
    if (name === "textarea") {
      const fname = c.name;
      if (disabled || "disabled" in c || !fname) continue;
      if (fname.length > MAX_NAME) {
        b.np("too_large");
        continue;
      }
      const lbl = labelOf(c, label);
      let def = rawText(n);
      if (def.startsWith("\r\n")) def = def.slice(2);
      else if (def.startsWith("\n")) def = def.slice(1); // a leading line break in the markup is not part of the value
      if (bytes(def) > MAX_VALUE) b.np("too_large");
      const f = b.visible(fname, "textarea", () => ({
        name: fname, type: "textarea", ...(lbl ? { label: lbl } : {}), ...("required" in c ? { required: true as const } : {}), ...("readonly" in c ? { readonly: true as const } : {}),
        ...(intAttr(c.maxlength) !== undefined ? { maxlength: intAttr(c.maxlength) } : {}),
        value: def,
      }));
      if (f) b.controls.push({ kind: "text", name: fname });
      continue;
    }
    if (name === "select") {
      const fname = c.name;
      if (disabled || "disabled" in c || !fname) continue;
      if (fname.length > MAX_NAME) {
        b.np("too_large");
        continue;
      }
      const lbl = labelOf(c, label);
      const f = b.visible(fname, "select", () => ({
        name: fname, type: "select", ...(lbl ? { label: lbl } : {}), ...("required" in c ? { required: true as const } : {}), ...("multiple" in c ? { multiple: true as const } : {}),
      }));
      if (!f) continue;
      f.options ??= [];
      // Options, in order, skipping disabled ones and disabled groups.
      const os: { n: N; off: boolean }[] = (n.children ?? []).slice().reverse().map((x) => ({ n: x, off: false }));
      let seen = 0;
      while (os.length && seen++ < NODE_BUDGET) {
        const { n: o, off } = os.pop()!;
        if (o.type !== "tag") continue;
        const oa = o.attribs ?? {};
        if (o.name === "optgroup") {
          for (let i = (o.children ?? []).length - 1; i >= 0; i--) os.push({ n: o.children![i], off: off || "disabled" in oa });
          continue;
        }
        if (o.name !== "option" || off || "disabled" in oa) continue;
        const text = norm(rawText(o));
        b.addOption(f, { value: oa.value ?? text, ...(text ? { label: text.slice(0, MAX_OPTION_LABEL) } : {}), ...("selected" in oa ? { selected: true as const } : {}) });
      }
      b.controls.push({ kind: "select", name: fname });
      continue;
    }
    if (name === "button" || name === "template" || name === "script" || name === "style") continue;
    if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push({ n: n.children[i], label, disabled, legend });
  }

  for (const f of b.fields.values()) if (f.omittedDefault) b.np("too_large");
  // Codex round 54: canonical collisions between any two different fields (a radio or checkbox group, or
  // repeated hidden fields of one name, are one field), and between a field and a POST target's query.
  const canon = new Map<string, string>();
  for (const key of b.fields.keys()) {
    const c = canonicalName(key.slice(2));
    if (canon.has(c) && canon.get(c) !== key) b.np("duplicate_names");
    canon.set(c, key);
  }
  if (action !== null && method === "POST") {
    const q = new URL(action);
    for (const n of q.searchParams.keys()) if (canon.has(canonicalName(n))) b.np("duplicate_names");
    // Codex round 54: a POST target's query must come only from the action attribute as written. With no
    // action of its own (missing, empty, or only a fragment), the page's query would ride along.
    const written = (a.action ?? "").trim().split("#")[0];
    if (q.search && !written.includes("?")) b.np("query_on_page");
  }
  let fields = [...b.fields.values()];
  let fields_omitted: number | undefined;
  if (fields.length > MAX_FIELDS) {
    b.np("too_many_fields");
    fields_omitted = fields.length - MAX_FIELDS;
    fields = fields.slice(0, MAX_FIELDS);
  }
  const not_allowed = ORDER.find((x) => b.flags.has(x));
  const out: FullForm = { index, method, action, enctype, ...(not_allowed ? { not_allowed } : {}), fields, ...(fields_omitted ? { fields_omitted } : {}), controls: b.controls };
  // The listing must fit whole; otherwise the form is listed without its fields and never sent.
  if (jsonBytes(publicForm(out)) > MAX_LISTING) {
    out.not_allowed = ORDER.find((x) => b.flags.has(x) || x === "too_large");
    out.fields_omitted = b.fields.size;
    out.fields = [];
  }
  return out;
}

// What an agent sees. Hidden fields are named with the fixed value "set by the site".
export function publicForm(f: FullForm): PublicForm {
  return {
    index: f.index, method: f.method, action: f.action, enctype: f.enctype, ...(f.not_allowed ? { not_allowed: f.not_allowed } : {}),
    fields: f.fields.map(({ hiddenField: _h, omittedDefault: _o, ...rest }) => rest),
    ...(f.fields_omitted ? { fields_omitted: f.fields_omitted } : {}),
  };
}

// ---- checking values and building the request ----

export type Problem = "not_a_field" | "hidden_field" | "readonly" | "not_an_option" | "not_multiple" | "required" | "too_long" | "bad_value";
export const PROBLEM_TEXT =
  "Some values do not fit the form (see untrusted_content.problems): not_a_field (no such field), hidden_field (set by the site, never by you), readonly, not_an_option (choose one of the listed options), not_multiple (one value only), required (this field needs a value), too_long (over its maxlength or 4,000 bytes), bad_value (control characters, or a line break outside a textarea). Nothing was sent.";
export const TOO_MANY_VALUES = `Too many values: at most ${MAX_KEYS} names and ${MAX_VALUES} bytes of values in all. Nothing was sent.`;
const MAX_PROBLEMS = 50;

export type Values = Record<string, string | string[]>;

export interface Built {
  method: "GET" | "POST";
  url: string; // the target: the action, with the query for a GET
  content_type?: string; // POST only
  body?: Buffer; // POST only: the exact bytes sent, hidden values included
  preview: { method: "GET" | "POST"; url: string; content_type?: string; body?: string }; // hidden values as "[set by the site]"
  preview_hash: string;
  sent_fields: { name: string; value: string }[]; // what the agent's side sent (visible fields, after defaults)
  hidden_names: string[];
  hidden_values: string[]; // internal only: to mask echoes of them in the site's answer (never returned or stored)
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const enc = (s: string) => {
  const p = new URLSearchParams();
  p.append(s, "");
  return p.toString().slice(0, -1); // "name=" without the "="
};
const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, "\r\n"); // form submission sends line breaks as CRLF

// Values check plus the request. Returns problems (nothing to send) or the request. Pure.
export function buildRequest(
  form: FullForm, pageUrl: string, raw: unknown,
): { problems: { field: string; problem: Problem }[] } | { tooMany: true } | { built: Built } | { tooLarge: true } | { payment: true } {
  const problems: { field: string; problem: Problem }[] = [];
  const add = (field: string, problem: Problem) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ field: field.slice(0, MAX_NAME), problem });
  };
  const values = new Map<string, string[]>();
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return { problems: [{ field: "", problem: "bad_value" }] };
    const entries = Object.entries(raw as Record<string, unknown>);
    let total = 0;
    if (entries.length > MAX_KEYS) return { tooMany: true };
    for (const [k, v] of entries) {
      const arr = typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
      if (!arr || arr.length > MAX_OPTIONS + 1) {
        add(k, "bad_value");
        continue;
      }
      for (const x of arr) total += bytes(x);
      total += bytes(k);
      values.set(k, arr);
    }
    if (total > MAX_VALUES) return { tooMany: true };
  }
  const visible = new Map(form.fields.filter((f) => !f.hiddenField).map((f) => [f.name, f]));
  const hiddenNames = new Set(form.fields.filter((f) => f.hiddenField).map((f) => f.name));
  // The resolved values of every visible field: the agent's where given, else the defaults.
  const chosen = new Map<string, string[]>();
  for (const [k, arr] of values) {
    const f = visible.get(k);
    if (!f) {
      add(k, hiddenNames.has(k) ? "hidden_field" : "not_a_field");
      continue;
    }
    if (f.readonly) {
      add(k, "readonly");
      continue;
    }
    const multi = !!f.multiple;
    if (!multi && arr.length !== 1) {
      add(k, "not_multiple");
      continue;
    }
    let bad = false;
    for (const x of arr) {
      if (bytes(x) > MAX_VALUE || (f.maxlength !== undefined && x.length > f.maxlength)) (add(k, "too_long"), (bad = true));
      else if (CONTROL.test(x) || (f.type !== "textarea" && /[\r\n]/.test(x))) (add(k, "bad_value"), (bad = true));
      else if (f.options && !f.options.some((o) => o.value === x)) (add(k, "not_an_option"), (bad = true));
    }
    if (!bad) chosen.set(k, [...new Set(arr)]);
  }
  for (const f of visible.values()) {
    if (chosen.has(f.name)) continue;
    if (f.type === "select" && !f.multiple) {
      const d = f.options?.find((o) => o.selected) ?? f.options?.[0]; // a single select sends its first option when none is selected
      chosen.set(f.name, d ? [d.value] : []);
    } else if (f.options) chosen.set(f.name, f.options.filter((o) => o.selected).map((o) => o.value).slice(0, f.type === "radio" ? 1 : undefined));
    else chosen.set(f.name, [f.value ?? ""]);
  }
  const flagged = new Set(problems.map((x) => x.field));
  for (const f of visible.values()) {
    const v = chosen.get(f.name) ?? [];
    if (flagged.has(f.name)) continue; // already reported (the agent's value was refused)
    if (f.required && (v.length === 0 || v.every((x) => x === ""))) add(f.name, "required");
  }
  if (problems.length) return { problems };

  // Pairs in tree order, as a browser builds them.
  const pairs: { name: string; value: string; hidden: boolean }[] = [];
  const radioDone = new Set<string>();
  for (const c of form.controls) {
    if (c.kind === "hidden") pairs.push({ name: c.name, value: c.value, hidden: true });
    else if (c.kind === "text") pairs.push({ name: c.name, value: chosen.get(c.name)?.[0] ?? "", hidden: false });
    else if (c.kind === "check") {
      if (chosen.get(c.name)?.includes(c.value)) pairs.push({ name: c.name, value: c.value, hidden: false });
    } else if (c.kind === "radio") {
      if (!radioDone.has(c.name) && chosen.get(c.name)?.[0] === c.value) (radioDone.add(c.name), pairs.push({ name: c.name, value: c.value, hidden: false }));
    } else {
      const f = visible.get(c.name);
      const v = chosen.get(c.name) ?? [];
      for (const o of f?.options ?? []) if (v.includes(o.value)) pairs.push({ name: c.name, value: o.value, hidden: false });
    }
  }
  // Codex round 52: whatever its source (the agent's text, an option, a default, a hidden value), no value
  // in the final request may hold a card number. Checked here, before the hash, and again before sending.
  if (pairs.some((p) => hasCardNumber(p.value))) return { payment: true };
  const real = pairs.map((p) => enc(crlf(p.name)) + "=" + enc(crlf(p.value))).join("&");
  const shown = pairs.map((p) => enc(crlf(p.name)) + "=" + (p.hidden ? HIDDEN_IN_PREVIEW : enc(crlf(p.value)))).join("&");
  const method = form.method as "GET" | "POST";
  let url: string;
  let previewUrl: string;
  if (method === "GET") {
    const u = new URL(form.action!);
    u.search = real;
    url = u.href;
    const pu = new URL(form.action!);
    pu.search = "";
    previewUrl = pu.href + (shown ? "?" + shown : "");
    if (url.length > MAX_TARGET) return { tooLarge: true };
  } else {
    url = form.action!;
    previewUrl = url;
    if (bytes(real) > MAX_BODY) return { tooLarge: true };
  }
  if (bytes(previewUrl) + bytes(method === "POST" ? shown : "") > MAX_PREVIEW) return { tooLarge: true };
  const visiblePairs = pairs.filter((p) => !p.hidden).map((p) => [p.name, p.value]);
  // The hash covers the page, the form's structure (method, action, encoding, every control's kind,
  // name and option value, required, maxlength, readonly) and the values sent from visible fields.
  // Never a hidden value: those change on every visit (CSRF tokens) and are never shown.
  const structure = [
    method, form.action, form.enctype,
    form.controls.map((c) => [c.kind, c.name, c.kind === "check" || c.kind === "radio" ? c.value : null]),
    form.fields.map((f) => [f.name, f.type, f.options?.map((o) => o.value) ?? null, !!f.required, f.maxlength ?? null, !!f.readonly, !!f.multiple]),
  ];
  const preview_hash = createHash("sha256").update(JSON.stringify(["tiresias-form-preview", 1, pageUrl, form.index, structure, visiblePairs])).digest("hex");
  return {
    built: {
      method, url,
      ...(method === "POST" ? { content_type: "application/x-www-form-urlencoded", body: Buffer.from(real, "utf8") } : {}),
      preview: { method, url: previewUrl, ...(method === "POST" ? { content_type: "application/x-www-form-urlencoded", body: shown } : {}) },
      preview_hash,
      sent_fields: pairs.filter((p) => !p.hidden).map((p) => ({ name: p.name, value: p.value })),
      hidden_names: [...new Set(pairs.filter((p) => p.hidden).map((p) => p.name))],
      hidden_values: [...new Set(pairs.filter((p) => p.hidden).map((p) => p.value))],
    },
  };
}

export const HASH_RE = /^[0-9a-f]{64}$/;

// Codex round 53: the card-number rule over the WHOLE final request: the target URL's path and every
// query name and value (decoded), and for a POST every body name and value. Run on the built request
// (preview and submit) and again on the final bytes right before a slip is claimed.
export function requestHasCard(method: "GET" | "POST", url: string, body?: Buffer): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true; // cannot be read back: treat as unsafe
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it encoded
  }
  const parts = [path, u.pathname];
  for (const [k, v] of u.searchParams) parts.push(k, v);
  if (method === "POST" && body) for (const [k, v] of new URLSearchParams(body.toString("utf8"))) parts.push(k, v);
  return parts.some(hasCardNumber);
}

// ---- the cookies of one submit call ----

// Only cookies the site set while THIS call fetched the form page are ever sent, and each only to the
// exact host that set it (Domain is ignored: host-only), Secure ones only over https. Path, SameSite
// and expiry beyond "already expired" are not modelled: the jar lives for one call and is then thrown
// away. Never stored, never shared between calls, never sent to another host.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;
const MAX_COOKIES = 50; // per host
const MAX_COOKIE_HEADER = 8192;
export class CookieJar {
  private byHost = new Map<string, Map<string, { value: string; secure: boolean }>>();
  frozen = false; // set once the form page is fetched: cookies from the submit's own answers are not kept
  collect(u: URL, headers: Headers): void {
    if (this.frozen) return;
    for (const line of headers.getSetCookie()) this.add(u, line);
  }
  private add(u: URL, line: string): void {
    const parts = line.split(";");
    const nv = parts[0];
    const eq = nv.indexOf("=");
    if (eq < 1) return;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!COOKIE_NAME.test(name) || value.length > 4096 || /[\u0000-\u001f\u007f;]/.test(value)) return;
    let secure = false;
    let expired = false;
    for (const p of parts.slice(1)) {
      const i = p.indexOf("=");
      const k = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i === -1 ? "" : p.slice(i + 1).trim();
      if (k === "secure") secure = true;
      else if (k === "max-age" && /^-?\d{1,12}$/.test(v) && Number(v) <= 0) expired = true;
      else if (k === "expires" && Date.parse(v) < Date.now()) expired = true;
    }
    if (secure && u.protocol !== "https:") return;
    const host = u.hostname.toLowerCase();
    let m = this.byHost.get(host);
    if (!m) this.byHost.set(host, (m = new Map()));
    if (expired) m.delete(name);
    else if (m.has(name) || m.size < MAX_COOKIES) m.set(name, { value, secure });
  }
  header(u: URL): string | undefined {
    const m = this.byHost.get(u.hostname.toLowerCase());
    if (!m) return undefined;
    const out: string[] = [];
    let size = 0;
    for (const [k, c] of m) {
      if (c.secure && u.protocol !== "https:") continue;
      const s = `${k}=${c.value}`;
      if (size + s.length + 2 > MAX_COOKIE_HEADER) break;
      out.push(s);
      size += s.length + 2;
    }
    return out.length ? out.join("; ") : undefined;
  }
  // v0.9 hardening (Codex round 2c, HIGH): every cookie value kept, so a submit masks the site's echo of one
  // exactly as it masks a hidden value (formflow.ts).
  values(): string[] {
    // Codex round 3c: a quoted value ("abc") is also tracked without its quotes, the token a site would echo.
    const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? [v, v.slice(1, -1)] : [v]);
    return [...this.byHost.values()].flatMap((m) => [...m.values()].flatMap((c) => unquote(c.value)));
  }
}

// ---- Echoes of hidden values and cookies in a site's answer ----
// v0.9 (Travis, item B): no longer masked. A form answer that repeats a secret the site set is withheld whole
// (echo.ts, formflow.ts afterSubmit).
