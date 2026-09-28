/**
 * Smoke test against the real sources.
 *
 * Unit tests use canned payloads, so they keep passing when a source goes
 * down or changes shape. That is exactly how the previous build shipped a
 * dictionary provider whose API had started returning 502. This script runs
 * the real pipeline against the real endpoints and fails loudly.
 *
 * Run with `npm run smoke`. It is not part of `npm run check`, because a
 * network outage is not a reason to block a commit.
 */
import { extractSignals } from '../src/core/intent/signals.ts';
import { routeIntent } from '../src/core/intent/router.ts';
import { runLookup } from '../src/core/lookup.ts';
import { PROVIDERS } from '../src/core/providers/all.ts';
import { findDefinitions } from '../src/core/page-definition.ts';
import { translateOnline, UNKNOWN_LANGUAGE } from '../src/core/online-translate.ts';
import type { Card, HttpClient, PageContext } from '../src/core/types.ts';
import { readFileSync } from 'node:fs';

// Read rather than repeated: a user agent naming a version this build is
// not is a lie told to every source it identifies itself to.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const UA = `QuickLookup/${version} (https://github.com/mmdemirbas/quick-lookup-extension)`;

const http: HttpClient = {
  async json<T>(url: string, init: { signal?: AbortSignal } = {}): Promise<T> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'Api-User-Agent': UA },
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return (await response.json()) as T;
  },
};

type Case = {
  text: string;
  page: PageContext;
  /**
   * Fetch this page and find its definitions of the selection, the way the
   * content script would. Pins the local extractor against real prose,
   * which no fixture can do.
   */
  readPage?: string;
  /** Ask sources for head-words in this language, as the settings would. */
  glossLanguage?: string;
  /**
   * Sources the assertion depends on; at least one must have answered.
   *
   * Providers abandon a source that misses its deadline and leave the slot
   * empty, which is correct behaviour and indistinguishable from a source
   * that answered wrongly — unless the check knows which source it is
   * asking about. Measured on a slow link, npm returned 200 in 132 ms,
   * 2315 ms and 5017 ms in three consecutive rounds, so this is the
   * difference between a useful signal and noise.
   */
  needs?: string[];
  /** What must be true for this case to count as working. */
  expect: (card: Card) => string | undefined;
};

/** Block elements, which the content script separates with a newline. */
const BLOCKS =
  'address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

/**
 * Roughly what the content script's TreeWalker produces: readable text with
 * scripts, styles and markup gone, blocks separated by a newline and
 * whitespace inside a block collapsed. The block rule matters — without it
 * a heading runs into the paragraph below and the extractor is measured on
 * text it will never see.
 */
async function readableText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'Api-User-Agent': UA } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const html = await response.text();
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(new RegExp(`</?(?:${BLOCKS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
}

const CASES: Case[] = [
  {
    text: 'ephemeral',
    page: { host: 'en.wikipedia.org', title: 'Reading' },
    glossLanguage: 'tr',
    // Tatoeba is listed so that its thin coverage skips the case instead of
    // failing it. `ephemeral` has exactly one sentence there, which is one
    // more than most technical vocabulary has.
    needs: ['free-dictionary', 'wiktionary', 'datamuse', 'tatoeba'],
    expect: (card) => {
      if ((card.slots.senses?.data?.length ?? 0) < 2) {
        return 'expected at least two senses for a common English word';
      }
      // The frequency comes from a third Datamuse request that is easy to
      // break without any test noticing: the other two return *other* words,
      // so a wrong endpoint still fills the related slot and looks healthy.
      const frequency = card.slots.frequency?.data;
      if (!frequency) return 'expected a frequency for a word the corpus knows';
      if (frequency.band !== 3) {
        return `expected "ephemeral" in band 3, got ${frequency.band} (${frequency.perMillion}/M)`;
      }
      const example = card.slots.examples?.data?.[0];
      if (!example) return 'expected a real sentence using the word';
      return example.translation
        ? undefined
        : 'expected the sentence to carry its Turkish translation';
    },
  },
  {
    text: 'planner',
    needs: ['free-dictionary', 'wiktionary'],
    page: {
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg table specification',
      topicTerms: ['iceberg', 'table', 'query', 'partition', 'metadata', 'database', 'spark'],
    },
    expect: (card) =>
      card.slots.senses?.data?.length ? undefined : 'expected definitions for a common word',
  },
  {
    text: 'Alan Turing',
    needs: ['wikipedia'],
    page: { host: 'news.example.com', title: 'Computing history' },
    expect: (card) =>
      card.slots.entity?.data?.title
        ? undefined
        : 'expected an entity card for a well known person',
  },
  {
    // The context-biasing mechanism end to end: "manifest" alone returns a
    // general article, but with the page topic it resolves to the sense the
    // reader is actually looking at.
    text: 'manifest',
    needs: ['wikipedia'],
    // Also pins the local definition extractor against real documentation
    // prose, which no fixture can do.
    readPage: 'https://iceberg.apache.org/spec/',
    page: {
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg table specification',
      topicTerms: ['iceberg', 'table', 'metadata', 'partition', 'snapshot', 'query'],
    },
    expect: (card) => {
      if (!/iceberg/i.test(card.slots.entity?.data?.title ?? '')) {
        return `page context did not steer the article (got "${card.slots.entity?.data?.title ?? 'nothing'}")`;
      }
      return card.slots.onPage?.data?.length
        ? undefined
        : 'expected the specification to define its own central term';
    },
  },
  {
    // The technical path end to end: a term with a Stack Overflow tag wiki
    // should come back defined by practitioners, not just described.
    text: 'Apache Iceberg',
    needs: ['stackexchange'],
    page: {
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg',
      topicTerms: ['table', 'format', 'analytics', 'metadata', 'snapshot'],
    },
    expect: (card) =>
      /table format/i.test(card.slots.gloss?.data ?? '')
        ? undefined
        : `tag wiki did not define the term (got "${card.slots.gloss?.data ?? 'nothing'}")`,
  },
  {
    // A live guard on the guidance filter. The `kubernetes` tag wiki is
    // entirely about what may be asked under the tag, so the correct
    // outcome is that it contributes nothing rather than a moderation
    // notice presented as a definition.
    text: 'Kubernetes',
    page: { host: 'kubernetes.io', title: 'Concepts', inCode: true },
    expect: (card) =>
      /off-topic|questions must/i.test(card.slots.gloss?.data ?? '')
        ? 'a tag wiki moderation notice reached the card as a definition'
        : undefined,
  },
  {
    // The registry path on an ordinary blog rather than a known dev host:
    // the page's own vocabulary is what routes this to the technical path.
    text: 'react-dom',
    needs: ['registry'],
    page: {
      host: 'blog.example.com',
      title: 'Rendering a React tree without the framework',
      topicTerms: ['react', 'javascript', 'npm', 'component', 'render'],
    },
    expect: (card) =>
      card.slots.facts?.data?.some((f) => f.label === 'Version' && f.source === 'npm')
        ? undefined
        : 'expected a current version from npm for a well known package',
  },
  {
    text: 'flexbox',
    needs: ['mdn'],
    page: {
      host: 'developer.mozilla.org',
      title: 'CSS layout',
      topicTerms: ['css', 'layout', 'browser', 'html'],
    },
    expect: (card) =>
      card.sources.includes('mdn') ? undefined : 'expected the web platform reference to answer',
  },
];

let failures = 0;
let skips = 0;

for (const testCase of CASES) {
  if (testCase.readPage) {
    try {
      const text = await readableText(testCase.readPage);
      const found = findDefinitions(testCase.text, text).map((d) => d.text);
      if (found.length) testCase.page = { ...testCase.page, definitions: found };
      console.log(`\n     read ${testCase.readPage} — ${(text.length / 1024) | 0}KB of text, ${found.length} definition(s)`);
    } catch (error) {
      console.log(`\n     could not read ${testCase.readPage}: ${(error as Error).message}`);
    }
  }
  const decision = routeIntent(extractSignals(testCase.text, testCase.page), 'en');
  const started = Date.now();
  let firstEvidenceMs = 0;

  const card = await runLookup(
    {
      id: 'smoke',
      text: testCase.text,
      uiLang: 'en',
      page: testCase.page,
      ...(testCase.glossLanguage ? { glossLanguage: testCase.glossLanguage } : {}),
    },
    decision,
    // The same list the service worker uses. Kept in one place because it was
    // in two, and a provider added to that one was silently missing from this
    // one — the smoke test kept passing and simply never asked the new source.
    { http, providers: PROVIDERS },
    {
      onUpdate: (partial) => {
        if (!firstEvidenceMs && partial.sources.some((s) => s !== 'links')) {
          firstEvidenceMs = Date.now() - started;
        }
      },
    },
  );

  // An assertion about what a source returned only means something if that
  // source returned. Without this a slow link reports as though the
  // extension were broken, and the signal this check exists to give is
  // exactly the one that gets lost.
  const required = testCase.needs ?? [];
  const skipped = required.length > 0 && !required.some((s) => card.sources.includes(s));
  const problem = skipped ? undefined : testCase.expect(card);
  const mark = skipped ? 'skip' : problem ? 'FAIL' : 'ok  ';
  if (problem) failures++;
  if (skipped) skips++;

  console.log(`\n${mark} "${testCase.text}" @ ${testCase.page.host}`);
  console.log(
    `     intent=${decision.intent}` +
      (decision.alsoFetch.length ? ` +[${decision.alsoFetch.join(',')}]` : '') +
      `  sources=${card.sources.filter((s) => s !== 'links').join(',') || 'none'}` +
      `  firstEvidence=${firstEvidenceMs || '—'}ms  total=${card.elapsedMs}ms`,
  );
  if (problem) console.log(`     ${problem}`);
  if (skipped) {
    console.log(`     none of [${required.join(', ')}] answered in time — nothing to judge`);
  }

  const gloss = card.slots.gloss?.data;
  if (gloss) console.log(`     gloss: ${gloss}`);

  for (const [i, sense] of (card.slots.senses?.data ?? []).slice(0, 3).entries()) {
    console.log(
      `     ${i + 1}. [${sense.partOfSpeech ?? '—'}] ${sense.definition.slice(0, 92)} (${sense.source})`,
    );
  }

  const frequency = card.slots.frequency?.data;
  if (frequency) {
    console.log(`     how common: ${frequency.label} (${frequency.perMillion}/M, band ${frequency.band})`);
  }

  for (const example of card.slots.examples?.data ?? []) {
    console.log(`     in use: ${example.text}`);
    if (example.translation) console.log(`             ${example.translation}`);
  }

  const related = card.slots.related?.data ?? [];
  if (related.length) {
    console.log(
      `     related: ${related.slice(0, 8).map((r) => `${r.word}·${r.kind[0]}`).join('  ')}`,
    );
  }

  for (const sentence of card.slots.onPage?.data ?? []) {
    console.log(`     on page: ${sentence.slice(0, 110)}`);
  }

  const translation = card.slots.translation?.data;
  if (translation) {
    console.log(
      `     ${translation.lang}: ${translation.text}` +
        ` [${translation.source}]`,
    );
  }

  const facts = card.slots.facts?.data ?? [];
  if (facts.length) {
    console.log(`     facts: ${facts.map((f) => `${f.label}=${f.value} (${f.source})`).join('  ')}`);
  }

  const extract = card.slots.extract?.data;
  if (extract) console.log(`     extract [${extract.source}]: ${extract.text.slice(0, 92)}`);

  const entity = card.slots.entity?.data;
  if (entity) {
    console.log(
      `     entity: ${entity.title} — ${entity.description ?? '(no description)'}` +
        ` image=${entity.imageUrl ? 'yes' : 'no'}`,
    );
  }
}

// The online translator is not a provider — it runs after the sources
// settle, and only when switched on — so it needs its own check. Each
// service is asked by name rather than through the chain: the chain hides a
// service that has started refusing behind the one that still answers, which
// is the right behaviour for a reader and the wrong one for a check.
console.log('\nOnline translator (only used when enabled in settings)');
for (const service of ['google', 'mymemory'] as const) {
  // Two short strings, because MyMemory's allowance counts characters.
  for (const text of ['ephemeral', 'A manifest is a metadata file.']) {
    const result = await translateOnline(http, {
      text,
      sourceLanguage: 'en',
      targetLanguage: 'tr',
      preference: service,
    });
    if (result) {
      console.log(`  ok   [${service}] "${text}" -> "${result.text}"`);
    } else {
      console.log(`  skip [${service}] "${text}" — no translation returned`);
      skips++;
    }
  }
}

/**
 * Text that is not English, with nothing saying what it is.
 *
 * This is the case that was silently broken: the caller named `en` for
 * everything, and both services answer `en` on German text by returning the
 * German back — HTTP 200, no error field, nothing to notice except reading
 * it. A check that only ever translates English cannot see that, which is
 * why this one is here rather than another English string.
 */
const GERMAN = 'Der Schnee fiel die ganze Nacht und die Schulen blieben geschlossen';
const detected = await translateOnline(http, {
  text: GERMAN,
  sourceLanguage: UNKNOWN_LANGUAGE,
  targetLanguage: 'tr',
});
if (!detected) {
  console.log('  skip [detect] a language nobody named — no translation returned');
  skips++;
} else if (detected.text.trim() === GERMAN) {
  console.log(`  FAIL [detect] the input came back unchanged: "${detected.text}"`);
  failures++;
} else {
  console.log(`  ok   [${detected.source}] German with no source named -> "${detected.text}"`);
}

const summary =
  failures > 0
    ? `${failures} case(s) failed.`
    : skips > 0
      ? `Every source that answered behaved as expected. ${skips} case(s) could not be checked.`
      : 'All sources responded as expected.';
console.log(`\n${summary}`);
process.exit(failures === 0 ? 0 : 1);
