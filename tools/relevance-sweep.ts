/**
 * Live relevance sweep against real Wikipedia.
 *
 * Unit tests pin the mechanism against the cases that were reported. They
 * cannot say whether the behaviour is better across the words actually
 * selected in a day, because that depends on what a live search engine
 * returns — and that is where relevance work goes wrong. A guard that looks
 * principled in a test can be too strict for half the words in the corpus,
 * and nothing in the suite would say so.
 *
 * `nothing` is a legitimate and often correct expectation: it means the
 * entity slot stays empty and the page's own sentence plus the dictionary
 * answer instead, which for `manifest` on the Iceberg documentation is the
 * better card.
 *
 * Run with `npm run sweep`. Outside `npm run check` for the same reason as
 * the smoke test: it needs a network, and Wikipedia being slow is not a
 * reason to block a commit. The 250 ms pause between cases is there because
 * a burst gets rate-limited; the extension never issues one.
 */
import { wikipediaProvider } from '../src/core/providers/wikipedia.ts';
import type { HttpClient } from '../src/core/types.ts';
import { readFileSync } from 'node:fs';

// Read rather than repeated: a user agent naming a version this build is
// not is a lie told to every source it identifies itself to.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const UA = `QuickLookup/${version} (https://github.com/mmdemirbas/quick-lookup-extension)`;

/**
 * The same shape as `platform/http.ts`, rebuilt here rather than imported.
 *
 * `node` runs a `.ts` tool by stripping types, and that mode rejects the
 * constructor parameter properties `platform/http.ts` uses. `tools/live-check.ts`
 * carries its own client for the same reason, so this follows it rather than
 * adding a transpiler to run one script.
 */
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

const ICEBERG = {
  host: 'iceberg.apache.org',
  title: 'Apache Iceberg table specification',
  topicTerms: ['iceberg', 'table', 'format', 'snapshot', 'metadata'],
};
const NEUTRAL = { host: 'news.example.com', title: 'Computing history' };
const K8S = { host: 'kubernetes.io', title: 'Kubernetes documentation', topicTerms: ['kubernetes', 'container', 'cluster'] };

/**
 * `want` is either `nothing`, or the title the article should have.
 *
 * Naming the title matters more than it looks. The first version of this
 * file only asked "an article, or none?", and `Parquet` passed while
 * returning an article about decorative wooden flooring — a check that
 * cannot see the defect it was written to look for.
 */
type Case = { text: string; page: Record<string, unknown>; want: string; why: string };

const NOTHING = 'nothing';

const CASES: Case[] = [
  // The two reported defects.
  { text: 'First', page: NEUTRAL, want: NOTHING, why: 'common word, disambiguation page' },
  { text: 'Schema', page: ICEBERG, want: NOTHING, why: 'reported: returned Apache Iceberg' },
  // Common words that would previously have been dragged to the page topic.
  { text: 'Set', page: ICEBERG, want: NOTHING, why: 'common word on a topical page' },
  { text: 'Order', page: ICEBERG, want: NOTHING, why: 'common word on a topical page' },
  { text: 'Table', page: ICEBERG, want: NOTHING, why: 'the page topic itself, as a common noun' },
  { text: 'Read', page: ICEBERG, want: NOTHING, why: 'common verb' },
  // Known to disagree, and left that way deliberately. Wikipedia has a real
  // article titled "Second" — the SI unit — so the title resolves and there
  // is no page topic to weigh it against. Every rule that would suppress it
  // also suppresses something wanted: "is this word in a dictionary" would
  // take out `Parquet` on a table-format page, and "did a capital start the
  // sentence" would take out a real name at a paragraph start. The card
  // still carries the dictionary sense, so the cost is a second section the
  // reader ignores, not a wrong answer. Reopen if a signal appears that
  // separates a word being *used* from a word being *named*.
  { text: 'Second', page: NEUTRAL, want: NOTHING, why: 'the SI unit is not what a sentence-opening "Second" means' },
  // Real entities that must keep working.
  { text: 'Alan Turing', page: NEUTRAL, want: 'Alan Turing', why: 'well known person' },
  { text: 'Ada Lovelace', page: NEUTRAL, want: 'Ada Lovelace', why: 'well known person' },
  { text: 'Linus Torvalds', page: NEUTRAL, want: 'Linus Torvalds', why: 'well known person' },
  { text: 'Apache Iceberg', page: ICEBERG, want: 'Apache Iceberg', why: 'the page subject, selected on purpose' },
  { text: 'Kubernetes', page: K8S, want: 'Kubernetes', why: 'technical entity' },
  { text: 'PostgreSQL', page: NEUTRAL, want: 'PostgreSQL', why: 'technical entity' },
  // Technical terms where a topical article genuinely exists.
  { text: 'Parquet', page: ICEBERG, want: 'Apache Parquet', why: 'the page is about table formats, not flooring' },
  { text: 'ACID', page: ICEBERG, want: 'ACID', why: 'acronym with a real article' },
  { text: 'Bloom filter', page: ICEBERG, want: 'Bloom filter', why: 'exact technical term' },
  { text: 'sharding', page: NEUTRAL, want: 'Shard', why: 'lowercase term, article is titled differently' },
  // Terms whose best answer is the page itself, not Wikipedia.
  { text: 'manifest', page: ICEBERG, want: NOTHING, why: 'the page defines it better than Wikipedia' },
  { text: 'compaction', page: ICEBERG, want: NOTHING, why: 'no single article names this subject' },
  { text: 'snapshot', page: ICEBERG, want: NOTHING, why: 'ambiguous across fields' },
];

async function main(): Promise<void> {
  let agreed = 0;
  const rows: string[] = [];

  for (const testCase of CASES) {
    const started = Date.now();
    let got = 'null';
    try {
      const result = await wikipediaProvider.run(
        { id: 'p', text: testCase.text, uiLang: 'en', page: testCase.page },
        { http, signal: new AbortController().signal, uiLang: 'en' },
      );
      got = result?.slots.entity?.title ?? 'null';
    } catch (error) {
      got = `THREW ${(error as Error).message}`;
    }
    const matches =
      testCase.want === NOTHING
        ? got === 'null'
        : got.toLowerCase().includes(testCase.want.toLowerCase());
    if (matches) agreed++;
    rows.push(
      `${matches ? 'ok  ' : 'DIFF'} ${testCase.text.padEnd(15)} ${String(Date.now() - started).padStart(5)}ms  ` +
        `want=${testCase.want.slice(0, 15).padEnd(15)} got=${got.slice(0, 32).padEnd(32)} ${testCase.why}`,
    );
    await new Promise((done) => setTimeout(done, 250));
  }

  for (const row of rows) console.log(row);
  console.log(`\n${agreed}/${CASES.length} agreed with what a reader should want.`);

  // Deliberately not an exit code. A DIFF row is a prompt to look, not a
  // failure: some of these expectations are judgement calls, and Wikipedia
  // changes underneath them without anything being wrong here.
}

await main();
