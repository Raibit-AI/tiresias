# Data for the meaning check

These files serve the optional meaning check in local model mode (`tiresias guard`, W-38 in `docs/SPEC.md`).
Nothing here is code, and nothing here is read until the owner runs `tiresias guard setup`.

## guard-starter.jsonl

Test strings for a detector. Each line is one `{ "text", "kind" }` object: an example of text a web page could
carry to steer an AI that reads it, in the form it would take planted in a page, one to three sentences long. The
meaning check compares each passage a local model is about to read with these examples. They are not instructions
for anyone, and Tiresias never shows them to a model.

We wrote them for Tiresias. Each kind of trick is written in several ways and set on several unrelated subjects (a
hotel's check-in page, release notes, a clinic, a recipe, a school calendar, a product review and so on), so the
library teaches the check the trick and not the topic. A few are in Spanish, French, German, Portuguese and
Chinese. Whatever the planted text names is a harmless stand-in: invented words in capitals, invented file names,
phone numbers from 555-0100 to 555-0199, and addresses on `.example`, a name reserved for examples that never reaches a real site.

The kinds: `override` (drop the user's question), `fake_system` (poses as the system or a developer), `fake_user`
(poses as the user), `fake_tool` (imitates Tiresias, a tool result or its end), `fake_assistant` (poses as the
model's own thinking or memory), `chat_marks` (chat template markers and role lines), `send_out` (open or pass on
an address, or put the conversation or a secret in an address or image link), `reply_shape` (what to say, add or
end with), `favour` (a polite request to recommend or mention something), `task_changed`, `fake_rule` (invented
terms or legal notices for AI readers), `urgency`, `persona`, `secrecy` (keep something from the user) and
`conditional` ("if you are an AI ...").

## guard-ordinary-urls.txt

About 100 public pages that `guard setup` reads, through Tiresias and under its usual rules, to gather ordinary
page text for the check to compare against. Most are everyday pages. The ones under the `about-ai` heading talk
about models, prompts and prompt injection without attacking anyone: they are the hardest ordinary text for the
check, and it has to learn to leave them alone. The text gathered from them stays in your own store. Swap the
list with `--ordinary-urls`, or give your own passages with `--ordinary`.
