// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { createHash } from "node:crypto";
import { preservationCases, r2Labels, sharedDescriptionPage } from "./form-review-cases.js";
import { timing } from "./helper.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHtml } from "../reader.js";
import { checkForm } from "../formflow.js";
import type { FullForm } from "../forms.js";

const url = "https://forms.example/contact";
function refused(markup: string, reason: string, values = {}) {
  const keep: { forms?: FullForm[] } = {};
  parseHtml(markup, url, keep);
  const form = keep.forms![0];
  assert.equal(form.not_allowed, reason, markup);
  const r = checkForm(url, 1, { pageUrl: url, finalUrl: url, form, flags: [] }, values);
  assert.ok("status" in r);
  assert.equal(r.status, "refused");
  assert.equal(r.form?.not_allowed, reason);
}
test("6.2: saved-balance payments and purchase actions are refused", () => {
  for (const action of [
    "Pay now using saved balance", "Checkout", "Check out", "Purchase", "Buy now", "Buy", "Place order", "placeorder",
    "PAY NOW", "pAyMeNt", "Payments", "Pays", "Paying", "Paid", "Purchases", "Purchased", "Purchasing",
    "Confirm order", "Complete order", "Submit order", "Finish order", "Finalize order", "Order now",
    "Purchase article", "Purchase comment", "Buy article", "Pay now for article",
    "Confirm purchase", "Complete payment", "Submit payment", "Finish purchase", "Finalize payment",
    "Buys", "Buying", "Bought", "Checkouts", "Checks out", "Checked out", "Checking out", "Places orders", "Placed order", "Placing orders",
  ]) {
    refused(`<form method="post" action="/send"><input type="hidden" name="invoice" value="INV-42"><input type="hidden" name="amount" value="10.00"><button>${action}</button></form>`, "payment");
  }
});

test("6.2: every order/payment confirmation verb and noun pair is refused", () => {
  for (const verb of ["Confirm", "Complete", "Submit", "Finish", "Finalize"]) {
    for (const noun of ["order", "purchase", "payment"]) {
      refused(`<form method=post action=/send><input type=hidden name=invoice value=INV42><button>${verb} ${noun}</button></form>`, "payment");
    }
  }
});

test("6.3: passwordless sign-in actions and username autocomplete are refused", () => {
  for (const action of ["Login", "Log in", "Sign in", "signin", "LOG IN", "sIgN iN", "Logins", "Signins", "Logs in", "Logged in", "Logging in", "Signs in", "Signed in", "Continue"]) {
    refused(`<form method="post" action="/start"><input type="email" name="email" ${action === "Continue" ? 'autocomplete="section-user username"' : ""}><button>${action}</button></form>`, "login_or_password", { email: "reader@example.net" });
  }
});

test("6.2 and 6.3: ordinary field names and labels do not contain action markers", () => {
  for (const label of ["display_name", "Display name", "repayment schedule", "buyer notes", "Designing for you", "assigning tasks", "Read our blog in Spanish"]) {
    const name = label.replace(/ /g, "_");
    for (const control of [
      `<input id=entry name="${name}">`,
      `<input type=search id=entry name="${name}">`,
      `<textarea id=entry name="${name}"></textarea>`,
    ]) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/feedback><label for=entry>${label}</label>${control}<button>Send</button></form>`, url, keep);
      assert.equal(keep.forms![0].not_allowed, undefined, `${label}: ${control}`);
    }
  }
});

test("6.2 and 6.3: action phrases preserve word order and block/attribute boundaries", () => {
  for (const markup of [
    "<p>Check it out</p>", "<p>In this log</p>", "<p>Sign your name in this box</p>",
    '<input name=note title="log" data-hint="in">',
    '<input name=note title="sign" data-hint="in">',
    '<input name=note title="place" data-hint="order">',
    '<input name=note title="check" data-hint="out">',
  ]) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(`<form method=post action=/feedback>${markup}<textarea name=message></textarea><button>Send</button></form>`, url, keep);
    assert.equal(keep.forms![0].not_allowed, undefined, markup);
  }
});

test("6.2 and 6.3: refused actions spend no slip use and send no POST", async () => {
  const { formPreview, formSubmit } = await import("../engine.js");
  const { grant, list } = await import("../slips.js");
  const { freshHome, serve, html, text } = await import("./helper.js");
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  for (const [markup, reason] of [
    ['<input type="hidden" name="invoice" value="INV-42"><button>Pay now using saved balance</button>', "payment"],
    ['<input type="email" name="email" autocomplete="username"><button>Sign in</button>', "login_or_password"],
    ...["Confirm order", "Complete order", "Order now", "Pagar ahora"].map((label) => [`<input type="hidden" name="invoice" value="INV42"><button>${label}</button>`, "payment"]),
    ['<input type="email" name="email"><button>Iniciar sesión</button>', "login_or_password"],
  ]) {
    freshHome();
    let posts = 0;
    const s = await serve((req, res) => {
      if (req.method === "POST") posts++;
      if (req.url === "/robots.txt") return text(res, "", 404);
      html(res, '<p>' + 'Ordinary page information. '.repeat(100) + `</p><form method="post" action="/send">${markup}</form>`);
    });
    try {
      grant({ action: "submit_form", site: s.url, path: "/send" });
      const values = reason === "payment" ? {} : { email: "reader@example.net" };
      assert.equal((await formPreview(s.url + "/page", 1, values)).form?.not_allowed, reason);
      assert.equal((await formSubmit(s.url + "/page", 1, values, "a".repeat(64))).form?.not_allowed, reason);
      assert.equal(posts, 0);
      assert.equal(list().items[0].uses_left, 1);
    } finally { await s.close(); }
  }
});

// Same thirteen languages as the injection shield. These are action labels, not page language hints.
const languages = [
  ["English", ["Sign in", "Log in", "Pay now", "Buy now", "Purchase", "Checkout", "Place order"], ["Search", "Newsletter", "Contact"]],
  ["Spanish", ["Iniciar sesión", "Acceder", "Pagar ahora", "Comprar", "Finalizar compra", "Realizar pedido"], ["Buscar", "Boletín", "Contacto"]],
  ["French", ["Se connecter", "Connexion", "Payer", "Acheter", "Passer à la caisse", "Passer commande"], ["Rechercher", "Lettre d’information", "Contact"]],
  ["German", ["Anmelden", "Einloggen", "Bezahlen", "Kaufen", "Zur Kasse", "Bestellung aufgeben"], ["Suchen", "Rundbrief", "Kontakt"]],
  ["Portuguese", ["Iniciar sessão", "Entrar", "Pagar agora", "Comprar", "Finalizar compra", "Fazer pedido"], ["Pesquisar", "Boletim", "Contato"]],
  ["Italian", ["Accedi", "Accedere", "Paga ora", "Acquista", "Procedi al pagamento", "Effettua ordine"], ["Cerca", "Notiziario", "Contatti"]],
  ["Dutch", ["Aanmelden", "Inloggen", "Betalen", "Kopen", "Afrekenen", "Bestelling plaatsen"], ["Zoeken", "Nieuwsbrief", "Contact"]],
  ["Russian", ["Войти", "Вход", "Оплатить", "Купить", "Оформить покупку", "Оформить заказ"], ["Поиск", "Рассылка", "Контакты"]],
  ["Chinese", ["登录", "登入", "立即支付", "购买", "結帳", "提交订单"], ["搜索", "订阅新闻", "联系"]],
  ["Japanese", ["ログイン", "サインイン", "今すぐ支払う", "購入する", "レジに進む", "注文を確定"], ["検索", "ニュースレター", "お問い合わせ"]],
  ["Korean", ["로그인", "로그인하기", "결제하기", "구매하기", "체크아웃", "주문하기"], ["검색", "소식지", "문의"]],
  ["Arabic", ["تسجيل الدخول", "الدخول", "ادفع الآن", "شراء", "إتمام الشراء", "تقديم الطلب"], ["بحث", "النشرة الإخبارية", "اتصل بنا"]],
  ["Hindi", ["साइन इन", "लॉग इन", "भुगतान करें", "खरीदें", "चेकआउट", "ऑर्डर दें"], ["खोजें", "समाचार पत्र", "संपर्क करें"]],
] as const;
for (const [language, denied, accepted] of languages) {
  test(`6.3: ${language} action recognition and ordinary forms`, () => {
    for (const label of denied) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/send><input name=entry><button>${label}</button></form>`, url, keep);
      const form = keep.forms![0];
      assert.ok(["payment", "login_or_password"].includes(form.not_allowed ?? ""), label);
      const r = checkForm(url, 1, { pageUrl: url, finalUrl: url, form, flags: [] }, { entry: "hello" });
      assert.ok("status" in r && r.status === "refused", label);
    }
    for (const label of accepted) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/send><input name=entry><button>${label}</button></form>`, url, keep);
      assert.equal(keep.forms![0].not_allowed, undefined, label);
    }
  });
}

test("6.2 and 6.3: ordinary form purposes remain accepted", () => {
  for (const label of [
    "Search", "Subscribe", "Subscribe now", "Newsletter", "Contact us", "Leave a comment", "Sort order", "Order by date",
    "Sign up for updates", "display", "buyer", "designing", "blog in Spanish",
  ]) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(`<form action=/send><input name=entry><button>${label}</button></form>`, url, keep);
    assert.equal(keep.forms![0].not_allowed, undefined, label);
  }
});

test("6.3: Unicode word edges and phrase boundaries are preserved", () => {
  for (const markup of [
    '<input name=entry title="iniciar" data-hint="sesión">',
    '<p>Iniciar</p><p>sesión</p>', '<p>Confirm</p><p>order</p>',
    '<button>recomprar</button>', '<button>angemeldeter</button>', '<button>оплатиться</button>',
  ]) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(`<form method=post action=/send>${markup}<textarea name=message></textarea></form>`, url, keep);
    assert.equal(keep.forms![0].not_allowed, undefined, markup);
  }
});

// Regression corpus from the guard before this working-tree change: all are parsed as HTML,
// including text-node boundaries, attributes, references and the original ASCII tokenisation.
const previouslyRefused: [string, string][] = [
  ['<button><span>Pay</span><span>now</span></button>', "payment"],
  ['<button><i>Buy</i>now</button>', "payment"],
  ['<button>x<span>pay</span>y</button>', "payment"],
  ['<button><span>Lo</span><span>gin</span></button>', "login_or_password"],
  ['<button><span>log</span><span>in</span></button>', "login_or_password"],
  ['<p>Log</p><p>in</p>', "login_or_password"],
  ['<p>Check</p><p>out</p>', "payment"],
  ['<p>Place</p><p>order</p>', "payment"],
  ['<input name=entry title="myPay">', "payment"],
  ['<input name=entry title="payé">', "payment"],
  ['<input name=entry placeholder="payment">', "payment"],
  ['<input name=entry aria-label="Login help article search">', "login_or_password"],
  ['<label>Login help article search<input name=entry></label><button>Send</button>', "login_or_password"],
  ['<label>Comments about your payment experience<input name=entry></label><button>Send</button>', "payment"],
  ['<button>Payment help article search</button>', "payment"],
  ['<button>Payment article search</button>', "payment"],
  ['<p>Comment about payment options in this blog post</p><button>Post comment</button>', "payment"],
  ['<p>Feedback about payments</p>', "payment"],
  ['<p>Discussion of login help</p>', "login_or_password"],
  ['<input name=entry aria-describedby=help></form><p id=help>Buy now</p>', "payment"],
  ['<input name=card_number>', "payment"],
  ['<input type=password name=secret>', "login_or_password"],
  ['<input name=entry autocomplete=username>', "login_or_password"],
  ['<input type=file name=attachment>', "file_upload"],
  ['<div class=g-recaptcha></div>', "captcha"],
];
test("6.2 and 6.3: parser regression table preserves previously refused forms", () => {
  for (const [body, reason] of previouslyRefused) {
    refused(`<form method=post action=/send>${body}</form>`, reason);
  }
});

test("6.2 and 6.3: new phrases and languages see joined and spaced inline pieces", () => {
  for (const [body, reason] of [
    ['<button><span>Confirm</span><span>order</span></button>', "payment"],
    ['<button><span>Con</span><span>firm order</span></button>', "payment"],
    ['<button><span>Iniciar</span><span>sesión</span></button>', "login_or_password"],
    ['<button><span>Ini</span><span>ciar sesión</span></button>', "login_or_password"],
    ['<label><span>Confirm</span><span>order</span><input name=entry></label>', "payment"],
    ['<label><span>Iniciar</span><span>sesión</span><input name=entry></label>', "login_or_password"],
    ['<input name=entry title="Confirm order">', "payment"],
    ['<input name=entry title="Iniciar sesión">', "login_or_password"],
  ]) refused(`<form method=post action=/send>${body}</form>`, reason);
});

const ambiguousActions = [
  ["Commander", "maintenant", "payment"], ["Zahlen", "jetzt", "payment"],
  ["Kauf", "jetzt", "payment"], ["Koop", "nu", "payment"], ["Compra", "ahora", "payment"],
  ["Paga", "ora", "payment"], ["Entrar", "agora", "login_or_password"],
  ["Accede", "ahora", "login_or_password"], ["Acceder", "ahora", "login_or_password"],
  ["Connexion", "maintenant", "login_or_password"], ["Achat", "maintenant", "payment"],
  ["Вход", "сейчас", "login_or_password"], ["买", "现在", "payment"], ["買", "現在", "payment"],
  ["사기", "지금", "payment"], ["الدخول", "الآن", "login_or_password"], ["دفع", "الآن", "payment"],
  ["Payer", "maintenant", "payment"], ["Compre", "agora", "payment"],
  ["Acceda", "ahora", "login_or_password"], ["Accedi", "ora", "login_or_password"],
  ["Accedere", "ora", "login_or_password"], ["Anmelden", "jetzt", "login_or_password"],
  ["Anmeldung", "jetzt", "login_or_password"], ["Aanmelden", "nu", "login_or_password"],
  ["Aanmelding", "nu", "login_or_password"], ["Войти", "сейчас", "login_or_password"],
  ["Приобрести", "сейчас", "payment"], ["الدفع", "الآن", "payment"],
] as const;

test("6.3: ambiguous foreign words require the whole submit-control text, value or alt", () => {
  for (const [word, now, reason] of ambiguousActions) {
    for (const label of [word, `${word} ${now}`]) {
      for (const control of [
        `<button>${label}</button>`, `<button type=button>${label}</button>`,
        `<input type=submit value="${label}">`, `<input type=button value="${label}">`,
        `<input type=image value="${label}">`, `<input type=image alt="${label}">`,
        `<input type=submit alt="${label}">`, `<input type=button alt="${label}">`,
      ]) refused(`<form method=post action=/send>${control}</form>`, reason);
    }
    for (const body of [
      `<label>${word}<input name=entry></label><button>Send</button>`,
      `<input name=entry title="${word}" value="${word}" alt="${word}" aria-label="${word}"><button>Send</button>`,
      `<input type=reset value="${word}" alt="${word}"><button>Send</button>`,
      `<button value="${word}" aria-label="${word}">Send</button>`,
      `<button>${word} details</button>`, `<button>Details ${word}</button>`,
      `<button>${word} ${now} details</button>`,
    ]) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/send>${body}</form>`, url, keep);
      assert.equal(keep.forms![0].not_allowed, undefined, body);
    }
  }
});

test("6.3: ordinary Commander/Zahlen labels and complete foreign action buttons", () => {
  for (const label of ["Commander name", "Zahlen und Fakten"]) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(`<form method=post action=/send><label>${label}<input name=entry></label><button>${label}</button></form>`, url, keep);
    assert.equal(keep.forms![0].not_allowed, undefined, label);
  }
  for (const [label, reason] of [
    ["Commander", "payment"], ["Zahlen", "payment"], ["Entrar", "login_or_password"],
    ["Comprar", "payment"], ["买", "payment"], ["결제", "payment"],
  ]) refused(`<form method=post action=/send><button>${label}</button></form>`, reason);
  for (const body of [
    '<button><span>Comman</span><span>der</span></button>',
    '<button><span>Commander</span><span>maintenant</span></button>',
    '<button><span>买</span><span>现在</span></button>',
  ]) refused(`<form method=post action=/send>${body}</form>`, "payment");
  for (const body of [
    '<button><span>Commander</span><span> name</span></button>',
    '<button><div>Commander</div><div>name</div></button>',
    '<button>Send</button><p>Commander</p>',
    '<p>Commander</p><button>Send</button>',
  ]) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(`<form method=post action=/send>${body}</form>`, url, keep);
    assert.equal(keep.forms![0].not_allowed, undefined, body);
  }
});

test("r2: every table label is refused by the real parser and request builder", () => {
  for (const [language, purchase, login] of r2Labels) {
    refused(`<form method=post action=/send><input type=hidden name=invoice value=INV42><button>${purchase}</button></form>`, "payment");
    if (login) refused(`<form method=post action=/send><input type=email name=email><button>${login}</button></form>`, "login_or_password", { email: "reader@example.net" });
  }
});

test("r2: closed filler grammar permits zero, one or two fillers, never arbitrary gaps", () => {
  const phrases = [
    ["Confirm", "order", ["your", "the"], "payment"], ["Place", "order", ["my", "the"], "payment"],
    ["Complete", "order", ["your", "this"], "payment"], ["Confirmar", "pedido", ["mi", "el"], "payment"],
    ["Confirmer", "commande", ["ma", "la"], "payment"], ["Bestellung", "bestatigen", ["meine", "die"], "payment"],
    ["Concluir", "pedido", ["meu", "o"], "payment"], ["Conferma", "ordine", ["mio", "il"], "payment"],
    ["Plaats", "bestelling", ["mijn", "de"], "payment"], ["Подтвердить", "заказ", ["мой", "этот"], "payment"],
  ] as const;
  for (const [first, last, fillers, reason] of phrases) {
    for (const gap of ["", fillers[0], fillers.join(" ")]) {
      const label = [first, gap, last].filter(Boolean).join(" ");
      for (const body of [`<button>${label}</button>`, `<input name=entry title="${label}">`, `<button>${label.split(" ").map(w => `<span>${w}</span>`).join("")}</button>`])
        refused(`<form method=post action=/send>${body}</form>`, reason);
    }
    for (const gap of ["very unusual", `${fillers.join(" ")} ${fillers[0]}`]) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/send><button>${first} ${gap} ${last}</button></form>`, url, keep);
      assert.equal(keep.forms![0].not_allowed, undefined, `${first} ${gap} ${last}`);
    }
  }
});

test("r2: now works on either side of complete ambiguous action labels", () => {
  for (const [word, now, reason] of [...ambiguousActions,
    ["Order", "now", "payment"], ["Ordina", "ora", "payment"], ["Bestel", "nu", "payment"], ["اطلب", "الآن", "payment"], ["订购", "立即", "payment"],
  ]) for (const label of [`${now} ${word}`, `${word} ${now}`]) {
    for (const body of [`<button>${label}</button>`, `<input type=submit value="${label}">`, `<input type=image alt="${label}">`])
      refused(`<form method=post action=/send>${body}</form>`, reason);
  }
});

test("r2: login complements remain whole-control labels with a closed grammar", () => {
  for (const label of ["Accedi con email", "Entrar com e-mail", "Aanmelden met e-mail", "Acceder a mi cuenta", "Войти по почте", "الدخول إلى حسابك"]) {
    for (const body of [`<button>${label}</button>`, `<input type=submit value="${label}">`, `<input type=image alt="${label}">`])
      refused(`<form method=post action=/send>${body}</form>`, "login_or_password");
    for (const extended of [`${label} details`, `Details ${label}`]) {
      const keep: { forms?: FullForm[] } = {};
      parseHtml(`<form method=post action=/send><button>${extended}</button></form>`, url, keep);
      assert.equal(keep.forms![0].not_allowed, undefined, extended);
    }
  }
});

test("r2: generated corpus preserves every frozen parent-parser refusal", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("../../src/test/fixtures/form-refusals-parent.json", import.meta.url), "utf8")) as { commit: string; cases: number; sha256: string; refusals: [number, string][] };
  const cases = preservationCases();
  assert.equal(fixture.commit, "8776fa4");
  assert.equal(cases.length, fixture.cases);
  assert.equal(createHash("sha256").update(JSON.stringify(cases)).digest("hex"), fixture.sha256);
  assert.equal(fixture.refusals.length, 5524);
  const frozen = new Map(fixture.refusals);
  for (const [i, markup] of cases.entries()) {
    const keep: { forms?: FullForm[] } = {};
    parseHtml(markup, url, keep);
    if (frozen.has(i)) assert.ok(keep.forms![0].not_allowed, `parent ${frozen.get(i)} refusal lost at case ${i}: ${markup}`);
  }
});

test("r2: twenty forms sharing a large description fit the worker budget", async (t) => {
  const { runUntrusted, stopWorker } = await import("../sandbox.js");
  const body = sharedDescriptionPage();
  stopWorker();
  const oldBudget = process.env.TIRESIAS_PARSE_BUDGET_MS;
  // Let the old implementation finish, so timing() itself catches the regression.
  process.env.TIRESIAS_PARSE_BUDGET_MS = "15000";
  const start = performance.now();
  try {
    const result = await runUntrusted<{ forms: FullForm[] }>({ op: "forms", body, url }, body.length);
    const ms = performance.now() - start;
    t.diagnostic(`20-form shared-description worker: ${ms.toFixed(1)} ms (${body.length} bytes)`);
    timing(ms < 3000, `shared-description forms took ${ms.toFixed(1)} ms`);
    assert.equal(result.forms.length, 20);
    assert.ok(result.forms.every(f => !f.not_allowed));
  } finally {
    stopWorker();
    if (oldBudget === undefined) delete process.env.TIRESIAS_PARSE_BUDGET_MS;
    else process.env.TIRESIAS_PARSE_BUDGET_MS = oldBudget;
  }
});

test("r2: submit values and button texts spend audit text budget, including cache hits", () => {
  // Each repeated value is cheap to classify but must still be charged on every read.
  // 500 * 1100 attributes were under budget before the extra submit-value scan was charged.
  const keep: { forms?: FullForm[] } = {};
  parseHtml(`<form method=post action=/send>${'<input type=submit value="'.concat("x".repeat(1100), '">').repeat(500)}</form>`, url, keep);
  assert.equal(keep.forms![0].not_allowed, "too_large");
  const buttons: { forms?: FullForm[] } = {};
  parseHtml(`<form method=post action=/send>${`<button>${"x".repeat(1500)}</button>`.repeat(180)}</form>`, url, buttons);
  assert.equal(buttons.forms![0].not_allowed, "too_large");
});
