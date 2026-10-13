/**
 * Service worker: the only place lookups are orchestrated.
 *
 * Content scripts stay thin because they run on every page. Everything that
 * costs anything — network, ranking, caching — happens here, once per
 * browser rather than once per tab.
 */
import { runLookup } from '../core/lookup.ts';
import { extractSignals } from '../core/intent/signals.ts';
import { routeIntent } from '../core/intent/router.ts';
import { LruCache, cardShape, lookupKey } from '../core/cache.ts';
import { PersistentStore } from '../core/store.ts';
import { localStore } from '../platform/storage.ts';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../core/settings.ts';
import type { Card, LookupRequest } from '../core/types.ts';
import { PROVIDERS } from '../core/providers/all.ts';
import { ext } from '../platform/browser.ts';
import { packLookup } from '../platform/packs.ts';
import { createHttpClient } from '../platform/http.ts';
import {
  detectCapabilities,
  detectLanguage,
  hasTranslator,
  translate,
  uiLanguage,
} from '../platform/ai.ts';
import { translateOnline, UNKNOWN_LANGUAGE } from '../core/online-translate.ts';
import { sameLanguage } from '../core/language.ts';
import type {
  BridgeHealth,
  CollectedContext,
  KeyState,
  StatusResponse,
  ToBackground,
  ToPanel,
} from '../shared/messages.ts';
import { openPanel } from '../shared/panel.ts';
import {
  buildRequest,
  clipExcerpt,
  lookupFor,
  type Attachment,
  type Conversation,
} from '../core/chat.ts';
import { apiTarget, bridgeTarget, ChatError, streamChat } from '../platform/anthropic.ts';
import {
  maskApiKey,
  readApiKey,
  readBridgeToken,
  writeApiKey,
  writeBridgeToken,
} from '../platform/secrets.ts';

const VERSION = ext.runtime.getManifest().version;
const http = createHttpClient(VERSION);

/**
 * Opened once per service-worker lifetime, not once per lookup. The worker is
 * torn down after about thirty seconds of inactivity, so "once" is often and
 * the metadata read behind this is what keeps it cheap when no pack exists.
 */
const packs = packLookup();

let settings: Settings = DEFAULT_SETTINGS;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Two cache layers, because they solve different problems.
 *
 * The service worker is torn down after about thirty seconds of inactivity,
 * so an in-memory cache alone would be cold for almost every real lookup —
 * it only helps within a burst, such as reading four words in one paragraph.
 * The persistent layer is what makes a word looked up yesterday instant
 * today.
 */
const memory = new LruCache<Card>({ maxEntries: 60, ttlMs: CACHE_TTL_MS });
const persistent = new PersistentStore<Card>(localStore(), {
  maxEntries: 400,
  ttlMs: CACHE_TTL_MS,
  maxHistory: 300,
});

/** One controller per tab: a new lookup cancels whatever that tab was doing. */
/**
 * One lookup at a time per surface. A tab is keyed by its id; the panel has
 * no tab of its own, so it gets a key that no tab id can collide with.
 */
const PANEL = 'panel';
const inFlight = new Map<number | typeof PANEL, AbortController>();

/**
 * The page the reader asked to discuss, waiting for the panel to collect it.
 *
 * Held here rather than pushed, because opening the panel and collecting the
 * page happen in the same gesture and the panel is usually not listening yet
 * when the page arrives. Broadcast as well, for when it already is.
 */
let pendingAttachment: Attachment | undefined;

/**
 * The last card each tab finished, so a question about a word can carry what
 * was already found out about it.
 *
 * Per tab rather than one global, because "what is on screen where the reader
 * is asking" is a per-tab fact and the panel serves whichever tab is in front.
 * Held rather than read back out of the cache: the cache is keyed by a shape
 * this side would have to recompute, and a hit there would only prove the word
 * was looked up on this host at some point, not that it is the card in view.
 * Dropped with the tab, below.
 */
const lastCard = new Map<number, { url: string; card: Card }>();

/** One answer at a time. Asking again abandons the one still arriving. */
let chatController: AbortController | undefined;

function toPanel(message: ToPanel): void {
  ext.runtime.sendMessage(message).catch(() => {
    // The panel was closed mid-answer. The abort below handles the stream.
  });
}

async function loadSettings(): Promise<Settings> {
  const stored = await ext.storage.sync.get('settings');
  settings = mergeSettings(stored.settings);
  return settings;
}

async function saveSettings(next: Settings): Promise<void> {
  settings = mergeSettings(next);
  await ext.storage.sync.set({ settings });
  const tabs = await ext.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    ext.tabs.sendMessage(tab.id, { type: 'QL_SETTINGS_CHANGED', settings }).catch(() => {
      // A tab with no content script — an extension page, or the store.
    });
  }
}

/**
 * Cards go to the tab that asked and to every extension page at once.
 *
 * The panel is a mirror rather than a second client: it shows whatever was
 * looked up last, in whichever tab, which is what lets an answer outlive the
 * page it was found on. A lookup started from the panel itself has no tab,
 * and then only the broadcast carries it.
 */
function send(tabId: number | undefined, card: Card): void {
  if (tabId !== undefined) {
    ext.tabs.sendMessage(tabId, { type: 'QL_CARD', card }).catch(() => {
      // The tab navigated away mid-lookup. The abort below handles the rest.
    });
  }
  ext.runtime.sendMessage({ type: 'QL_CARD', card }).catch(() => {
    // No extension page is open. This is the usual case, not a failure.
  });
}

/**
 * Adds a translation of the lead sense.
 *
 * Runs after the sources have settled rather than as a provider, because it
 * translates an answer we already have instead of fetching a new one, and
 * because it is the one step that may be unavailable on any given machine.
 */
async function addGloss(
  card: Card,
  targetLanguage: string,
  pageLanguage: string | undefined,
): Promise<boolean> {
  if (!settings.appearance.showGloss) return false;
  // Nothing here could translate, so nothing below is worth working out.
  if (!hasTranslator() && !settings.appearance.onlineTranslation) return false;

  // What is worth translating differs by what was selected. For a single
  // word the definition carries far more than the word alone would, and the
  // dictionary already supplied the word itself. For anything longer the
  // selection is the thing the reader wants rendered.
  const existing = card.slots.translation?.data;
  const subject =
    card.intent === 'word'
      ? (card.slots.gloss?.data ?? card.slots.senses?.data?.[0]?.definition)
      : card.query;
  if (!subject) return false;

  // What language the subject is in, in order of how much it can be trusted.
  //
  // A dictionary definition is written in the language the dictionary was
  // asked in, so the word path knows — and that is the interface language,
  // not English. Both dictionary sources build their URL from it
  // (`entries/tr/…`, `tr.wiktionary.org`), so a Turkish interface gets
  // Turkish definitions; calling those English asked for a Turkish-to-
  // Turkish translation, which both services accept and answer with the
  // input unchanged. The card then printed the same sentence twice, once as
  // the definition and once as its translation.
  //
  // Anything else is the reader's own selection. A detector, where the
  // browser has one, is evidence; the page's `lang` is a declaration;
  // neither may be invented.
  const source =
    card.intent === 'word'
      ? uiLanguage().split('-')[0] || 'en'
      : ((await detectLanguage(subject)) ?? pageLanguage ?? undefined);
  if (source && sameLanguage(source, targetLanguage)) return false;

  // On-device first, always: it is free, private and needs no allowance. It
  // needs both languages named, so an unknown source skips it rather than
  // guessing — the online chain can still ask a service that detects.
  const onDevice = source ? await translate(subject, source, targetLanguage) : undefined;
  const online =
    onDevice || !settings.appearance.onlineTranslation
      ? undefined
      : await translateOnline(http, {
          text: subject,
          sourceLanguage: source ?? UNKNOWN_LANGUAGE,
          targetLanguage,
          preference: settings.appearance.translationService,
          ...(settings.appearance.translationEmail
            ? { email: settings.appearance.translationEmail }
            : {}),
        });

  const translated = onDevice ?? online?.text;
  if (!translated) return false;

  card.slots.translation = {
    id: 'translation',
    state: 'filled',
    data: {
      text: translated,
      lang: targetLanguage,
      source: onDevice ? 'on-device' : (online?.source ?? 'online'),
      // Dictionary head-words are a different answer, not a worse one, so a
      // translator arriving later must not discard them.
      ...(existing?.equivalents?.length ? { equivalents: existing.equivalents } : {}),
    },
  };
  if (!card.order.includes('translation')) card.order.push('translation');
  return true;
}

/**
 * Which backend answers, and what it needs to be let in.
 *
 * Returns nothing when the chosen one has no credential yet, which is a
 * different thing from a rejected one and gets a different sentence.
 */
async function chosenTarget() {
  if (settings.chat.backend === 'bridge') {
    const token = await readBridgeToken();
    return token ? bridgeTarget(settings.chat.bridgeUrl, token) : undefined;
  }
  const apiKey = await readApiKey();
  return apiKey ? apiTarget(apiKey) : undefined;
}

/**
 * Streams one answer, reporting every fragment as it arrives.
 *
 * The conversation is sent whole by the panel rather than kept here: this
 * worker is torn down after about thirty seconds of inactivity, so anything
 * it remembered between two questions would be gone by the second one.
 */
async function handleChat(requestId: string, conversation: Conversation): Promise<void> {
  chatController?.abort('superseded');
  const controller = new AbortController();
  chatController = controller;

  try {
    await loadSettings();
    const target = await chosenTarget();
    if (!target) {
      toPanel({
        type: 'QL_CHAT_FAILED',
        requestId,
        message:
          settings.chat.backend === 'bridge'
            ? 'No bridge token is set. Start the bridge, run ./ctl pair and paste the token into the extension settings.'
            : 'No API key is set. Add one in the extension settings.',
        retryable: false,
      });
      return;
    }

    const result = await streamChat({
      target,
      body: buildRequest(conversation, settings.chat.contextChars),
      signal: controller.signal,
      onDelta: (delta) =>
        toPanel({ type: 'QL_CHAT_DELTA', requestId, kind: delta.kind, text: delta.text }),
    });
    toPanel({
      type: 'QL_CHAT_DONE',
      requestId,
      usage: result.usage,
      backend: settings.chat.backend,
      complete: result.complete,
    });
  } catch (error) {
    // The reader pressed stop, or asked something else. Neither is a failure
    // and neither has anything to say to them.
    if (controller.signal.aborted) return;

    // Which failure it was decides what the reader should do, so the classes
    // stay apart all the way to the panel: a rejected key is worth fixing, a
    // 529 is worth waiting out, and a dropped connection is worth retrying.
    if (error instanceof ChatError) {
      toPanel({
        type: 'QL_CHAT_FAILED',
        requestId,
        message: error.message,
        retryable: error.retryable,
      });
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      toPanel({ type: 'QL_CHAT_FAILED', requestId, message: detail, retryable: true });
    }
  } finally {
    if (chatController === controller) chatController = undefined;
  }
}

/**
 * Asks a tab for the page behind it and stages the result.
 *
 * Clipped here rather than in the content script, because the budget is a
 * setting and the worker is the only side that has read it. The full length
 * measured before the cut travels with it, so the panel can say what was
 * left out instead of presenting a fragment as the page.
 */
async function stageAttachment(tabId: number): Promise<void> {
  try {
    const collected = (await ext.tabs.sendMessage(tabId, {
      type: 'QL_COLLECT_CONTEXT',
    })) as CollectedContext | undefined;
    if (!collected?.attachment) return;

    await loadSettings();
    // Only when the card in that tab is about the very text that is selected.
    // A card about a neighbouring word would ground the answer in the wrong
    // definition while looking exactly like grounding, so the rule is exact
    // and the absent case is the ordinary one.
    const lookup = lookupFor(collected.attachment, lastCard.get(tabId));
    pendingAttachment = {
      ...collected.attachment,
      excerpt: clipExcerpt(collected.attachment.excerpt, settings.chat.contextChars),
      ...(lookup ? { lookup } : {}),
    };
    toPanel({ type: 'QL_CHAT_ATTACH', attachment: pendingAttachment });
  } catch {
    // No content script here: a PDF viewer, the extension gallery, or another
    // extension's page. The panel opens anyway and the reader can still type.
  }
}

/**
 * Remembers a finished card as what that tab is showing.
 *
 * Finished, not streaming: a partial card is missing whichever source was
 * slowest, and half a dictionary entry handed to a conversation as the
 * dictionary entry is the kind of thing nobody would ever notice.
 *
 * A lookup started from the panel has no tab and no page, and is not
 * remembered — there is nothing it is on screen beside.
 */
function keep(tabId: number | undefined, url: string | undefined, card: Card): void {
  if (tabId !== undefined && url) lastCard.set(tabId, { url, card });
}

async function handleLookup(
  tabId: number | undefined,
  requestId: string,
  text: string,
  page: LookupRequest['page'],
): Promise<void> {
  const surface = tabId ?? PANEL;
  inFlight.get(surface)?.abort('superseded');
  const controller = new AbortController();
  inFlight.set(surface, controller);

  const trimmed = text.slice(0, settings.limits.maxSelectionChars);
  const lang = uiLanguage().split('-')[0] || 'en';
  const decision = routeIntent(extractSignals(trimmed, page), lang);
  const shape = cardShape({
    ...(settings.appearance.showGloss
      ? { glossLanguage: settings.appearance.glossLanguage }
      : {}),
    onlineTranslation: settings.appearance.onlineTranslation,
    translationService: settings.appearance.translationService,
    packs: await packs.signature(),
    build: VERSION,
  });
  const key = lookupKey(trimmed, decision.intent, page.host ?? '', lang, shape);

  const remember = async (card: Card) => {
    await persistent.recordLookup({
      query: trimmed,
      intent: decision.intent,
      host: page.host ?? '',
      at: Date.now(),
      ...(card.slots.gloss?.data ? { gloss: card.slots.gloss.data } : {}),
    });
    // The panel lists recent lookups and is open while they happen, so it
    // has to be told. The card cannot carry this: it is finished before the
    // write that this awaits.
    const items = await persistent.history();
    ext.runtime.sendMessage({ type: 'QL_HISTORY', items }).catch(() => {
      // No extension page is open, which is the usual case.
    });
  };

  const cached = memory.get(key) ?? (await persistent.read(key));
  if (cached) {
    if (controller.signal.aborted) return;
    memory.set(key, cached);
    send(tabId, { ...cached, requestId });
    keep(tabId, page.url, cached);
    void remember(cached);
    return;
  }

  const budget = setTimeout(() => controller.abort('budget'), settings.limits.timeoutMs);
  try {
    const request: LookupRequest = {
      id: requestId,
      text: trimmed,
      uiLang: lang,
      page,
      ...(settings.appearance.showGloss
        ? { glossLanguage: settings.appearance.glossLanguage }
        : {}),
    };
    const card = await runLookup(
      request,
      decision,
      { http, providers: PROVIDERS, packs },
      {
        signal: controller.signal,
        onUpdate: (partial) => send(tabId, partial),
      },
    );

    if (controller.signal.aborted) return;
    if (await addGloss(card, settings.appearance.glossLanguage, page.lang)) send(tabId, card);
    keep(tabId, page.url, card);

    // Only cache a card that actually answered. Caching an empty result
    // would make a transient outage stick for a week.
    if (card.sources.some((source) => source !== 'links')) {
      memory.set(key, card);
      void persistent.write(key, card);
    }
    void remember(card);
  } finally {
    clearTimeout(budget);
    if (inFlight.get(surface) === controller) inFlight.delete(surface);
  }
}

/**
 * Whether the bridge is running and accepts the token we would send it.
 *
 * Done here because the token lives here. `/health` needs it like every
 * other route, so a green answer means both halves are right — running, and
 * reachable with this token — which is the difference between a settings
 * page and a mystery in the panel later.
 */
async function bridgeHealth(url: string, typed?: string): Promise<BridgeHealth> {
  const token = typed?.trim() || (await readBridgeToken());
  if (!token) {
    return { ok: false, reason: 'no-token', detail: 'No token is stored, and none was typed.' };
  }
  const base = url.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.chat.bridgeUrl;
  try {
    const response = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      return { ok: false, reason: 'refused', detail: 'The bridge refused the token.' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'status', detail: `It answered HTTP ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

ext.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'QL_LOOKUP':
      // A message with no tab behind it came from the panel, which is an
      // extension page. Its lookups run the same way and answer by broadcast.
      void loadSettings()
        .then(() => handleLookup(tabId, message.requestId, message.text, message.page))
        .catch(() => {
          // Every provider already swallows its own failure; reaching here
          // means the orchestration itself failed and there is no card.
        });
      return false;

    case 'QL_CANCEL':
      if (tabId !== undefined) inFlight.get(tabId)?.abort('cancelled');
      return false;

    case 'QL_GET_SETTINGS':
      void loadSettings().then(sendResponse);
      return true;

    case 'QL_SAVE_SETTINGS':
      void saveSettings(message.settings).then(() => sendResponse(settings));
      return true;

    case 'QL_SET_SITE_MODE':
      void loadSettings().then(() => {
        const next = structuredClone(settings);
        if (message.mode === null) delete next.sites[message.host];
        else next.sites[message.host] = { mode: message.mode };
        return saveSettings(next).then(() => sendResponse(settings));
      });
      return true;

    case 'QL_GET_STATUS':
      void detectCapabilities().then((capabilities) => {
        const status: StatusResponse = { capabilities, version: VERSION };
        sendResponse(status);
      });
      return true;

    case 'QL_GET_HISTORY':
      void persistent.history().then(sendResponse);
      return true;

    case 'QL_STAR':
      void persistent.toggleStar(message.query, message.host).then(sendResponse);
      return true;

    case 'QL_PACKS_CHANGED':
      packs.refresh();
      // Cached cards were composed without the new pack, or with one that has
      // gone. The persistent layer is keyed by a shape that now includes the
      // installed set, so only the in-memory copy has to be dropped.
      memory.clear();
      return false;

    case 'QL_CHAT_SEND':
      void handleChat(message.requestId, message.conversation);
      return false;

    case 'QL_CHAT_CANCEL':
      chatController?.abort('cancelled');
      return false;

    case 'QL_CHAT_TAKE_ATTACHMENT': {
      // Taken, not read. A page left staged would attach itself to whatever
      // the reader asked next, which may be about something else entirely.
      sendResponse(pendingAttachment ?? null);
      pendingAttachment = undefined;
      return false;
    }

    case 'QL_CHAT_KEY_STATE':
      void Promise.all([readApiKey(), readBridgeToken()]).then(([key, token]) => {
        const state: KeyState = {
          present: Boolean(key),
          masked: maskApiKey(key),
          bridgePresent: Boolean(token),
          bridgeMasked: maskApiKey(token),
        };
        sendResponse(state);
      });
      return true;

    case 'QL_BRIDGE_HEALTH':
      void bridgeHealth(message.url, message.token).then(sendResponse);
      return true;

    case 'QL_CHAT_SAVE_KEY':
      void (message.which === 'bridge'
        ? writeBridgeToken(message.apiKey)
        : writeApiKey(message.apiKey)
      )
        .then(() => Promise.all([readApiKey(), readBridgeToken()]))
        .then(([key, token]) => {
          const state: KeyState = {
            present: Boolean(key),
            masked: maskApiKey(key),
            bridgePresent: Boolean(token),
            bridgeMasked: maskApiKey(token),
          };
          sendResponse(state);
        });
      return true;

    case 'QL_CLEAR_HISTORY':
      void persistent.clearHistory().then(() => persistent.history().then(sendResponse));
      return true;

    default:
      return false;
  }
});

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.create({
    id: 'quick-lookup',
    title: 'Quick Lookup "%s"',
    contexts: ['selection'],
  });
  // The panel cannot be opened by the card's own button: that press reaches
  // the extension as a message, leaving the service worker to make the call
  // with no gesture behind it, and Chrome refuses that outright. A
  // context-menu click hands the worker a real one, and is the entry point
  // Chrome's own documentation uses.
  ext.contextMenus.create({
    id: 'quick-lookup-panel',
    title: 'Open the Quick Lookup panel',
    contexts: ['all'],
  });
  // The same gesture rule applies, which is why discussing a page is a
  // context-menu item rather than a button on the card: the panel has to be
  // opened by something the browser counts as a user action.
  ext.contextMenus.create({
    id: 'quick-lookup-discuss',
    title: 'Discuss this page with Claude',
    contexts: ['all'],
  });
  // Expired entries are dropped on read, but a key never read again would
  // otherwise occupy storage forever.
  void persistent.prune();
});

ext.runtime.onStartup?.addListener(() => {
  void persistent.prune();
});

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'quick-lookup-panel') {
    openPanel(tab?.windowId);
    return;
  }
  if (info.menuItemId === 'quick-lookup-discuss') {
    // Opened first and without awaiting anything. The gesture is spent by the
    // first `await`, and collecting the page needs a round trip to the tab.
    openPanel(tab?.windowId);
    if (tab?.id !== undefined) void stageAttachment(tab.id);
    return;
  }
  if (info.menuItemId !== 'quick-lookup' || tab?.id === undefined) return;
  ext.tabs
    .sendMessage(tab.id, { type: 'QL_TRIGGER_LOOKUP', text: info.selectionText })
    .catch(() => {
      // No content script on this page; nothing to trigger.
    });
});

ext.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'lookup-selection' || tab?.id === undefined) return;
  ext.tabs.sendMessage(tab.id, { type: 'QL_TRIGGER_LOOKUP' }).catch(() => {
    // As above.
  });
});

ext.tabs.onRemoved.addListener((tabId) => {
  inFlight.get(tabId)?.abort('tab closed');
  inFlight.delete(tabId);
  lastCard.delete(tabId);
});
