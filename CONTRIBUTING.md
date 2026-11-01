# Contributing

Thank you for helping. Tiresias is small on purpose, so a few rules keep it that way.

## Before you start

- Read `docs/SPEC.md`. It is the single source of truth: section 2 (principles) never changes, section 4 lists what is wanted, section 9 records every decision and why.
- A change that breaks a principle does not ship. In particular: Tiresias never pretends to be a person, never solves a CAPTCHA, and never sends anything in the owner's name without a permission slip.
- Open an issue first for anything larger than a fix, so we can agree on the shape.

## Building and testing

```sh
npm ci
npm test
```

Node 22.13 or newer. The tests use local servers only and never touch the real network.

## What a change needs

- A test that fails without the change. For a guard (anything that refuses, caps or checks), say in the pull request that you checked the test fails with the guard removed.
- The spec updated: the register row, the interface (section 6) if a tool or command changed, and a dated row in section 9 for any judgment call.
- No new dependency without discussion. Every third-party package is reviewed before it is added.
- Fixed text in replies. Anything that came from the web stays inside `untrusted_content`.

## Style

Match the code around you. Plain words in messages and docs: say what happened and what to do next.
