# The working list

This folder holds the same files as `data/`: the meaning check's example texts (`guard-starter.jsonl`) and its
list of ordinary pages (`guard-ordinary-urls.txt`). The difference is who reads them.

- `data/` is the released list. It ships in the package, and `tiresias guard setup` reads it. Nobody edits it.
- `data-next/` is the working list. New examples go here as they are found, and nothing reads it at run time.

Whatever differs between the two is what the next build will carry. At a build the working list is checked and
copied over the released one, so in every release the two are the same: the release workflow stops while they
differ.

```sh
node scripts/library.mjs status     # what is waiting for the next build, counted by kind
node scripts/library.mjs check      # is the working list well formed?
node scripts/library.mjs release    # check, then make data/ the same as data-next/
node scripts/library.mjs gate       # fails unless the two are the same (a step in the release workflow)
```

## Adding an example

One line of JSON with exactly `text` and `kind`. Write the trick the way it would sit in a page, one to three
sentences, in new words, and set it on several unrelated subjects so the check learns the trick and not the
topic. Whatever the planted text names is a harmless stand-in: an invented word in capitals, an invented file name, a
phone number from 555-0100 to 555-0199, or an address on `.example`. Nothing points anywhere real, and `check`
refuses an address or a phone number that is not one of these. The kinds are
listed in [`data/README.md`](../data/README.md).

A trick seen on a real page is rewritten before it goes in: the real site, names, links and wording are not
copied here.

After a release, run `tiresias guard setup` again and measure on a test set the library's writers have not
seen. A test set is fair once. When its misses become examples here, the next round needs a new set.
