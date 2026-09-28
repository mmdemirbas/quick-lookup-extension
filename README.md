# Quick Lookup

Select text on any page and get the most useful answer for that kind of
text, in place. An English word gets definitions, pronunciation and
related words. A name gets an entity card. A technical term gets the
sense that fits the page you are reading.

Facts come from data sources. Meanings are ranked against the page you are
reading, locally and with no model. The browser's own translator, where
there is one, only translates — it is never the source of a fact.

![The card open under the word "manifest" on a page about table formats: pronunciation, how common the word is, the sentence on this page that defines it, then dictionary senses](docs/images/card-on-page.png)

| A word | A technical term | A name |
|---|---|---|
| ![Card for "ephemeral": pronunciation, frequency, senses, a Turkish translation, example sentences, related words](docs/images/card-word-light.png) | ![Card for "webpack": the page's own definition, a summary, facts from the package registry, where to look it up](docs/images/card-technical-light.png) | ![Card for "Alan Turing": a Wikipedia summary with birth and death dates and field](docs/images/card-entity-light.png) |

Website: <https://mmdemirbas.github.io/quick-lookup-extension/>

Design and reasoning: `SPEC.md`.
Landscape research and the decisions behind it: `docs/redesign-2026-08-11.md`.
Competitor survey, defect causes and the current roadmap: `docs/round-2026-08-16.md`.
Health check, sources and relevance results: `docs/status-2026-08-16.md`.
Status on 2026-08-22: `docs/status-2026-08-22.md` — the panel, the link every
meaning now carries, and two colours that were too pale to read.
Reviews since: `docs/review-2026-08-30.md` and `docs/review-2026-09-02.md` (the
page conversation), and `docs/audit-2026-09-06.md` (twenty-nine defects in the
card, the sources, the selection and the settings page).

## Build and load

```bash
npm install
npm run build
```

Then, in Brave, Chrome or Edge:

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on Developer mode.
3. Choose "Load unpacked" and select `dist/chromium`.

For Firefox, build with `node build.mjs --firefox` and load
`dist/firefox` through `about:debugging`.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Builds the unpacked extension into `dist/chromium` |
| `npm run dev` | Same, with watch and source maps |
| `npm run typecheck` | Type checks without emitting |
| `npm test` | Unit tests over the pure core, no browser needed |
| `npm run check` | Typecheck, tests and build — the gate before any commit |
| `npm run smoke` | Runs the real pipeline against the real sources |
| `npm run sweep` | Puts 20 known terms through the entity provider against live Wikipedia |
| `npm run unused` | Lists code nothing reaches — a name defined once and called nowhere |
| `npm run preview` | Builds a page that renders the card outside the extension |
| `npm run shots` | Renders the card pictures in `docs/images` from that page |

`npm run smoke` is separate from `npm run check` on purpose. Unit tests
use canned payloads, so they keep passing when a source goes down or
changes shape — which is how the previous version shipped a dictionary
provider whose API had started returning 502. The smoke test catches
that, but a network outage is not a reason to block a commit.

## How it decides what to show

1. **Signals.** Token count, casing, script, identifier style, shape
   patterns, whether the selection is inside code, the host, and which
   software ecosystems the page shows evidence of. All local, under a
   millisecond.
2. **Intent.** One of word, phrase, entity, technical, citation,
   quantity, foreign. When the answer is ambiguous the router widens the
   fetch rather than guessing — providers run in parallel and merge, so
   fetching two paths costs one extra request and gives a better card.
3. **Sources.** Several per job, with independent failure modes. One
   source failing removes a slot, never the card. The first one consulted
   is the page itself: it is scanned locally for a sentence that *defines*
   the selection, which is the only way to learn what a term means on this
   particular page. It costs no request and sends nothing anywhere. Every
   meaning wears the mark of the source that wrote it, and that mark is the
   link to the page it came from — the dictionary text is Wiktionary's,
   under CC BY-SA, and that licence asks for the link back.
4. **Page context.** The page is profiled once — title, headings,
   description — and that profile biases the search and ranks the senses.
   This is what makes `manifest` on an Iceberg page resolve to Apache
   Iceberg rather than the everyday adjective. It also decides which
   sources are worth asking: a package registry answers only on a page
   about that ecosystem, because `iceberg` is a real npm package and it
   is not the one anyone reading about table formats means.

## Dictionary packs

A pack is a dictionary file kept on this device. It answers at the speed of
local storage, works offline, and has no daily allowance — which makes it the
right source for the thing done most often, reading a page in a second
language word by word.

Settings → Dictionary packs takes **dictd** (`.index` + `.dict.dz`),
**StarDict** (`.ifo` + `.idx` + `.dict.dz`) and tab-separated files. Between
them those cover most of what is downloadable;
[FreeDict](https://freedict.org/downloads/) publishes both binary forms for
about 150 language pairs. Its English-Turkish edition is 36,589 head-words
with pronunciation: measured here, the files are read in 84 ms and installed
in 2.4 seconds, and the 36,589 index entries become 34,328 stored words
because one spelling with several parts of speech is one entry.

Unpack the archive first. Browsers cannot read `.tar.xz`, so that step has to
happen outside the extension.

A pack's languages decide what it fills, never its name. A monolingual pack
writes definitions; a bilingual one writes the translation line, and only
when its target is the language you asked for — otherwise two installed packs
would put a German line above Turkish words. Selecting an inflected form
still works: the base form is tried when the exact one is not a head-word.

## Triggering

The card opens when you select text. Ten guards keep that from being
intrusive; the two that matter most are a short dwell before opening,
and cancelling entirely if a copy shortcut follows the selection.

Per site, or globally, the trigger can be changed to a handle, to
require a modifier, or to nothing at all. The toolbar popup switches the
current site without opening settings.

## The panel

The card lives in the page, so it dies with the page. The panel does not:
it is the same card, in a place the page cannot take away. A word looked up
before you navigated is still there afterwards, and the list under it
reopens anything looked up earlier without finding the page it was on.

Open it from the toolbar popup, or by right-clicking and choosing "Open the
Quick Lookup panel". It cannot be opened from a button in the card: that
press reaches the extension as a message, and by then the user action the
browser requires is over. Measured, not assumed — a call from the service
worker with nothing behind it is refused with "may only be called in
response to a user gesture", and the check that proves it runs in the
browser suite.

It mirrors rather than competes. Whatever was looked up last, in whichever
tab, is what the panel shows; the only lookup it starts itself is the one
you ask for from its list.

The panel has a second view, **Chat**, which is the opposite kind of thing:
the thread exists only there, and nothing else in the extension holds it.

## Discussing a page

A lookup answers "what does this mean". Everything else you might want from
a page — is this claim true, what is this actually arguing, how would I
reply — is a conversation.

Right-click a page and choose **Discuss this page with Claude**. The panel
opens on the Chat view with that page attached, and your question goes with
it. Then keep browsing: the thread stays, and the next question carries
whatever page you are on by then. That is the point of it — read a post,
open the paper it cites, and ask whether the paper says what the post
claimed.

**Ask** answers in the panel and needs an Anthropic API key, which is the one
thing in this extension that needs one. Add it in settings; it is kept on this
device and is not synced. Sonnet 5 answers by default, and the picker under the
composer changes the model for the conversation you are in.

**The local bridge** is the third way, and the one that spends no money. Run
`node bridge/server.mjs` from this repository; it prints an address and a token
to paste into settings, then switch "Answered by" to the local bridge. Answers
then come from Claude Code on this machine, using the subscription already
there, and no key is stored in the browser at all.

It only works on the machine running it and only while it runs, and it is
slower — about five seconds to the first word, against well under one for the
API, because a session starts per question. In exchange nothing is metered.

Claude Code runs there with every tool that reads, writes or reaches the
network switched off, in an empty directory. That is the important part rather
than a detail: a web page is text somebody else wrote, and an agent that can
both read a page and act on the machine is a way for that page to act on the
machine. Note that Claude Code's own `--restricted` mode is not sufficient for
this — it stops commands running but still allows file writes — so the bridge
names the tools it refuses rather than trusting the mode.

**claude.ai↗** needs nothing at all. It composes the same question and page,
puts them on your clipboard and opens a new conversation at claude.ai to paste
into. No key, no cost, and it works before you have set anything up — what it
costs instead is that you leave the page to talk.

If you had looked a word up on that page and it is still selected, the card
goes with the question too — the definitions, the related words, the extract
and the sources, exactly as they are drawn. That is the point: you are looking
at the card while you type, and without it the answer comes from the model's
own memory of the word rather than from what was fetched, with nothing on
screen to say which. The card travels only when it is about the selected text
and was looked up on that same page; a card about a neighbouring word would
ground the answer in the wrong meaning while looking exactly like grounding.
The chip above the composer says **with the card** when it happens.

Three things the panel tells you that it would be easy not to. It says which
page each question was asked against, whether the card went with it, and
**when the page was longer than the budget it says how much was sent** — an answer about the first third of a
page is a different thing from an answer about the page. The line under the
composer shows roughly what the thread has cost, and how much of it was
served from cache: asking five things about one page re-sends a prefix that
has not changed, which is billed at about a tenth.

Nothing is sent from the panel without that right-click, and nothing at all is
sent while no key is stored. The clipboard path sends nothing anywhere by
itself — it hands you the text and opens a tab; what happens next is a paste
you make.

## Comparing two words

Drag a card by its header or its foot and it detaches: it keeps its answer,
stops following selections, and stops being closed by them. It is marked
`KEPT` and stays where you put it until you close it.

The next selection then opens a second card *beside* it rather than on top of
it, which is the point — two words on screen at once is the only way to
compare them. Up to four can be kept at a time. Escape clears them in the
reverse of the order they arrived.

Inside any card, a related word is a button: one press looks it up in that
same card, and the header grows a control naming the word it returns to.

## Keeping what you find

Every card copies itself, from the row at its foot: as plain text, as
Markdown for notes, or as a tab-separated Anki note that imports without
touching Anki's options dialog. `Alt+C` takes the Markdown version without
reaching for the mouse.

What you copy is what you see, plus the sources, the reference link and the
page you were on. It goes to the clipboard and nowhere else.

Every card also carries the sentence you met the word in, with the word
marked. That is what lets a card that has been dragged aside — or a note read
weeks later — still say why the word was worth looking up.

Lookups are kept in the toolbar popup and in the panel. Starring one makes it
survive both the size cap and Clear, which is what turns the list from a log
into something worth coming back to.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings and the lookup cache |
| `contextMenus` | Right-click lookup on a selection |
| `unlimitedStorage` | Installed dictionary packs. One is about five megabytes of definitions, and the default extension quota is not much more than that in total |
| `activeTab` | Reading the selection when triggered by the shortcut |
| `sidePanel` | Opening the panel. Chromium only; Firefox's sidebar needs no permission |
| `<all_urls>` content script | The selection handle must be able to appear on any page. The always-on script only listens for selection changes; everything else is loaded on first use |
| Fifteen host permissions | Wikipedia, Wiktionary, freedictionaryapi.com, Datamuse, Tatoeba, Wikidata, Wikimedia images, Stack Exchange, npm, PyPI, crates.io, MDN, MyMemory, Google Translate and the Anthropic API. Each is listed with its reason in `manifest.config.js`. Stack Exchange, the registries and MDN are asked only for technical terms, the registries only on a page about that ecosystem, and the two translators only if you switch translation on. The Anthropic API is contacted only when a key is stored and only for a page you asked to discuss |

## Privacy

- No analytics, no remote code. No account or key is needed for anything
  except the panel's Chat view, and that one is off until you add a key — or
  until you run the local bridge, which needs no key at all.
- Selected text is sent only to the data source being queried, and only
  when a lookup was asked for.
- A copied card carries the URL of the page you were on, so the note can
  be traced back later. It reaches the clipboard and nothing else.
- One setting, off by default, sends the selection to a translation
  service for machines whose browser has no translator of its own. It is
  the only thing here that sends your text somewhere it was not already
  going, and the card names the service that answered. Two services are
  available and either can be chosen alone: Google's keyless endpoint,
  which has no allowance to exhaust, and MyMemory, which is documented
  but limited to 5,000 characters a day.
- The local bridge listens on 127.0.0.1 only, requires a bearer token, and
  refuses any request whose `Origin` is a web page. Loopback is not
  authentication: any page can send to a local port even when it cannot read
  the reply, and sending is enough to spend your subscription.
- The Chat view sends the *page*, not a word, so it is treated as the
  largest thing here: it needs a stored key **and** a right-click on that
  specific page, and it never runs on its own. A page can hold a draft, a
  message thread or an account number that no lookup would ever have
  transmitted. The key lives in local storage, is never synced, is never put
  in the settings object a content script can see, and the options page shows
  a mask rather than the key. Extension storage is not encrypted, so this is
  storage rather than secrecy — treat it as you would a `.env` file.
- Ranking always runs on the device: it is arithmetic over the page's own
  words, not a model. Translation runs on the device too when the browser
  provides a translator, and is skipped when it does not.
- Everything stored stays local. Preferences sync; the cache does not.

## License

The code is MIT; see [LICENSE](LICENSE). The data it shows is not part of this
repository and keeps its own terms: dictionary text fetched from Wiktionary is
CC BY-SA, which is why every Wiktionary panel links back to its page, and
dictionary packs such as FreeDict's are supplied by you, never redistributed
here.
