// SPDX-License-Identifier: Apache-2.0
// Stable structured corpus: do not change without regenerating the parent-parser fixture.
export function preservationCases(): string[] {
  const labels = ["Pay", "Log in", "Place order", "Confirm order", "Password", "card number", "captcha", "Checkout", "Pagar", "Iniciar sesión", "Commander", "Zahlen", "Accedi", "买", "로그인", "購入", "भुगतान", "الدخول", "Subscribe", "Commander name", "Zahlen und Fakten", "Search", "Order by date", "Confirm your order", "Sign me in"];
  const wraps = [
    (s: string) => `<button>${s}</button>`,
    (s: string) => `<input name=entry title="${s}">`,
    (s: string) => `<p>${s}</p>`,
    (s: string) => `<input name=entry aria-describedby=help></form><p id=help>${s}</p>`,
    (s: string) => `<button>${s.split(" ").map(w => `<span>${w}</span>`).join("")}</button>`,
    (s: string) => `<input type=submit value="${s}">`,
    (s: string) => `<label>${s}<input name=entry></label>`,
    (s: string) => `<input type=image alt="${s}">`,
  ];
  const variants = [(s: string) => s, (s: string) => s.toUpperCase(), (s: string) => s.replace(/ /g, "-"), (s: string) => s.replace(/ /g, "_"), (s: string) => s.replace(/ /g, "  "), (s: string) => s + " details"];
  const fields = ["", "<input type=password name=secret>", "<input name=entry autocomplete=username>", "<input name=card_number>", "<input type=file name=attachment>"];
  return labels.flatMap(s => wraps.flatMap(w => variants.flatMap(v => fields.map(f => `<form method=post action=/send>${f}${w(v(s))}</form>`))));
}
export const r2Labels = [
  ["English", "Confirm your order", "Sign me in"], ["Spanish", "Confirmar mi pedido", "Acceder a mi cuenta"],
  ["French", "Payer par carte", "Me connecter"], ["German", "Zahlungspflichtig bestellen", "Jetzt anmelden"],
  ["Portuguese", "Concluir pedido", "Entrar com e-mail"], ["Italian", "Ordina ora", "Accedi con email"],
  ["Dutch", "Bestel nu", "Aanmelden met e-mail"], ["Russian", "Заказать", "Войти по почте"],
  ["Chinese", "立即订购", null], ["Japanese", "注文を完了する", null], ["Korean", "주문 완료", null],
  ["Arabic", "اطلب الآن", "الدخول إلى حسابك"], ["Hindi", "ऑर्डर की पुष्टि करें", null],
] as const;
export const sharedDescriptionPage = () => `<p id=help>${"x y ".repeat(32768)}</p>` + Array.from({length: 20}, (_, i) => `<form method=post action=/send aria-describedby=help><input name=entry${i}><button>Send</button></form>`).join("");
