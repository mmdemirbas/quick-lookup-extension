/** Settings page. Reads and writes through the service worker. */
import { DEFAULT_SETTINGS, mergeSettings, type Modifier, type Settings, type TriggerMode } from '../core/settings.ts';
import type { TranslationPreference } from '../core/online-translate.ts';
import { ext } from '../platform/browser.ts';
import { downloadTranslation, translationAvailability } from '../platform/ai.ts';
import {
  classifyFiles,
  installPack,
  listPacks,
  readPack,
  removePack,
  type PackMeta,
  type PackPreview,
} from '../platform/packs.ts';
import type { BridgeHealth, KeyState, StatusResponse } from '../shared/messages.ts';
import { MODELS } from '../core/chat.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el as T;
};

const fields = {
  mode: $<HTMLSelectElement>('mode'),
  modifier: $<HTMLSelectElement>('modifier'),
  dwell: $<HTMLInputElement>('dwell'),
  maxWords: $<HTMLInputElement>('maxWords'),
  inEditable: $<HTMLInputElement>('inEditable'),
  showGloss: $<HTMLInputElement>('showGloss'),
  glossLanguage: $<HTMLSelectElement>('glossLanguage'),
  onlineTranslation: $<HTMLInputElement>('onlineTranslation'),
  translationService: $<HTMLSelectElement>('translationService'),
  translationEmail: $<HTMLInputElement>('translationEmail'),
  chatKey: $<HTMLInputElement>('chatKey'),
  chatBackend: $<HTMLSelectElement>('chatBackend'),
  chatBridgeUrl: $<HTMLInputElement>('chatBridgeUrl'),
  chatBridgeToken: $<HTMLInputElement>('chatBridgeToken'),
  chatModel: $<HTMLSelectElement>('chatModel'),
  chatContext: $<HTMLInputElement>('chatContext'),
};

for (const model of MODELS) {
  const option = document.createElement('option');
  option.value = model.id;
  // The unit is said once, in the hint beside the control. Repeating it in
  // every option made the select three times wider than any other on the
  // page, which is what set the whole column ragged.
  option.textContent = `${model.label} — $${model.inputPrice} / $${model.outputPrice}`;
  fields.chatModel.append(option);
}

let settings: Settings = DEFAULT_SETTINGS;

function fill(next: Settings): void {
  settings = next;
  fields.mode.value = next.trigger.mode;
  fields.modifier.value = next.trigger.modifier;
  fields.dwell.value = String(next.trigger.dwellMs);
  fields.maxWords.value = String(next.trigger.maxWords);
  fields.inEditable.checked = next.trigger.inEditable;
  fields.showGloss.checked = next.appearance.showGloss;
  fields.glossLanguage.value = next.appearance.glossLanguage;
  fields.onlineTranslation.checked = next.appearance.onlineTranslation;
  fields.translationService.value = next.appearance.translationService;
  fields.translationEmail.value = next.appearance.translationEmail;
  fields.chatBackend.value = next.chat.backend;
  fields.chatBridgeUrl.value = next.chat.bridgeUrl;
  fields.chatModel.value = next.chat.model;
  fields.chatContext.value = String(next.chat.contextChars);
  syncBackendFields();
  syncOnlineFields();
  renderSites();
  // The pair is read off the language select, and the select only holds the
  // stored language once this function has run. Without this the row was
  // always English-to-Turkish, so a reader whose gloss language is German
  // was offered a Turkish model, told it was ready, and still got no German.
  void renderTranslation();
}

/**
 * Says whether a key is stored, and never shows the key.
 *
 * The field stays empty even when one is set: a masked value in an editable
 * box is a trap, because saving the form would write the mask back as the
 * key. Typing replaces, and the button below removes.
 */
async function renderKeyState(): Promise<void> {
  const label = $('chatKeyState');
  const forget = $<HTMLButtonElement>('chatForget');
  try {
    const state = (await ext.runtime.sendMessage({ type: 'QL_CHAT_KEY_STATE' })) as
      | KeyState
      | undefined;
    const present = Boolean(state?.present);
    label.textContent = present
      ? `A key is stored on this device: ${state?.masked}. It is not synced to your other browsers.`
      : 'No key stored. The panel\u2019s Chat view cannot reach anything until one is added.';
    forget.hidden = !present;
    fields.chatKey.placeholder = present ? 'Type a new key to replace it' : 'sk-ant-\u2026';
    fields.chatBridgeToken.placeholder = state?.bridgePresent
      ? `Stored: ${state.bridgeMasked}. Type a new one to replace it`
      : 'Paste the bridge token (./ctl pair copies it)';
  } catch {
    label.textContent = 'Could not read the key state.';
  }
}

/** Bridge rows mean nothing while the API is answering, so they are hidden. */
function syncBackendFields(): void {
  const bridge = fields.chatBackend.value === 'bridge';
  for (const row of document.querySelectorAll<HTMLElement>('[data-backend="bridge"]')) {
    row.hidden = !bridge;
  }
}
fields.chatBackend.addEventListener('change', syncBackendFields);

/**
 * Asks the bridge whether it is there, before a question depends on it.
 *
 * `/health` needs the token like every other route, so a green answer here
 * means both halves are right — running, and reachable with this token.
 * Finding that out now is the difference between a settings page and a
 * mystery in the panel later.
 */
$<HTMLButtonElement>('chatBridgeTest').addEventListener('click', () => {
  const state = $('chatBridgeState');
  const url = fields.chatBridgeUrl.value.trim() || DEFAULT_SETTINGS.chat.bridgeUrl;
  const typed = fields.chatBridgeToken.value.trim();
  state.textContent = 'Checking\u2026';

  // Asked of the worker, because the token lives there. This page only ever
  // sees a masked form of a stored token, so testing from here could only
  // ever test one typed the same minute — and the box is cleared on save, so
  // the everyday case sent no token at all and reported every working bridge
  // as refusing its own token.
  void saveKeyIfTyped()
    .then(() =>
      ext.runtime.sendMessage({
        type: 'QL_BRIDGE_HEALTH',
        url,
        ...(typed ? { token: typed } : {}),
      }),
    )
    .then((health: BridgeHealth) => {
      if (health.ok) {
        state.textContent = 'The bridge answered. Claude Code is behind it.';
        return;
      }
      switch (health.reason) {
        case 'no-token':
          state.textContent = 'No token yet. Run ./ctl pair, paste the token, then test.';
          return;
        case 'refused':
          state.textContent = 'Reached it, but the token was refused.';
          return;
        case 'status':
          state.textContent = `Reached it, but ${health.detail}`;
          return;
        default:
          state.textContent = `Nothing is listening at ${url}. Start it with node bridge/server.mjs. (${health.detail})`;
      }
    });
});

$<HTMLButtonElement>('chatForget').addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'QL_CHAT_SAVE_KEY', apiKey: '' }).then(renderKeyState);
});

/** Writes a newly typed key, if one was typed, and clears the box either way. */
async function saveKeyIfTyped(): Promise<void> {
  const key = fields.chatKey.value.trim();
  const bridge = fields.chatBridgeToken.value.trim();
  if (key) {
    fields.chatKey.value = '';
    await ext.runtime.sendMessage({ type: 'QL_CHAT_SAVE_KEY', apiKey: key, which: 'api' });
  }
  if (bridge) {
    fields.chatBridgeToken.value = '';
    await ext.runtime.sendMessage({
      type: 'QL_CHAT_SAVE_KEY',
      apiKey: bridge,
      which: 'bridge',
    });
  }
  if (key || bridge) await renderKeyState();
}

/**
 * A number the reader typed, kept inside the range its input declares.
 *
 * `Number(value) || fallback` was two defects in one expression. A
 * legitimate zero is falsy, so "no wait at all" silently became the default
 * and the field snapped back with a "Saved" flash as though it had worked.
 * And nothing enforced `min`/`max`, because these inputs are not inside a
 * `<form>` and nothing calls `checkValidity()` — so a sixteen-minute dwell
 * saved happily and stopped the card ever opening again.
 *
 * The clamped value is written back, so the field shows what was stored
 * rather than what was asked for.
 */
function numberField(input: HTMLInputElement, fallback: number): number {
  const typed = input.valueAsNumber;
  if (!Number.isFinite(typed)) {
    input.value = String(fallback);
    return fallback;
  }
  const low = input.min === '' ? -Infinity : Number(input.min);
  const high = input.max === '' ? Infinity : Number(input.max);
  const kept = Math.min(high, Math.max(low, Math.round(typed)));
  input.value = String(kept);
  return kept;
}

function collect(): Settings {
  return mergeSettings({
    ...settings,
    trigger: {
      ...settings.trigger,
      mode: fields.mode.value as TriggerMode,
      modifier: fields.modifier.value as Modifier,
      dwellMs: numberField(fields.dwell, DEFAULT_SETTINGS.trigger.dwellMs),
      maxWords: numberField(fields.maxWords, DEFAULT_SETTINGS.trigger.maxWords),
      inEditable: fields.inEditable.checked,
    },
    appearance: {
      ...settings.appearance,
      showGloss: fields.showGloss.checked,
      glossLanguage: fields.glossLanguage.value,
      onlineTranslation: fields.onlineTranslation.checked,
      translationService: fields.translationService.value as TranslationPreference,
      translationEmail: fields.translationEmail.value.trim(),
    },
    chat: {
      ...settings.chat,
      backend: fields.chatBackend.value as Settings['chat']['backend'],
      bridgeUrl: fields.chatBridgeUrl.value.trim() || DEFAULT_SETTINGS.chat.bridgeUrl,
      model: fields.chatModel.value,
      contextChars: numberField(fields.chatContext, DEFAULT_SETTINGS.chat.contextChars),
    },
  });
}

function renderSites(): void {
  const list = $<HTMLUListElement>('sites');
  const hosts = Object.keys(settings.sites).sort();
  list.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No site rules yet.';
    list.append(empty);
    return;
  }

  for (const host of hosts) {
    const item = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;

    const select = document.createElement('select');
    for (const [value, label] of [
      ['auto', 'Open the card'],
      ['handle', 'Show a handle'],
      ['modifier', 'Only with modifier'],
      ['off', 'Do nothing'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = settings.sites[host]?.mode ?? 'auto';
    select.addEventListener('change', () => {
      settings.sites[host] = { mode: select.value as TriggerMode };
    });

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      delete settings.sites[host];
      renderSites();
    });

    item.append(name, select, remove);
    list.append(item);
  }
}

/**
 * Reports what this browser provides on the device.
 *
 * Only the translator and the language detector, because only those are
 * used. What to do when there is no translator is shown further down, next
 * to the control it affects.
 */
function renderStatus(status: StatusResponse): void {
  const box = $('status');
  const { capabilities } = status;
  box.replaceChildren();

  const headline = document.createElement('div');
  headline.className = 'headline';
  const abilities = [
    capabilities.detect && 'detect language',
    capabilities.translate && 'translate',
  ].filter(Boolean);
  // What the browser *exposes*, which is not the same as what is ready to
  // use — a translator can be present with no language pair downloaded. The
  // row above reports the readiness, so this must not claim it.
  headline.textContent = abilities.length
    ? `This browser can ${abilities.join(' and ')} on its own.`
    : 'This browser has no on-device translator.';

  const reason = document.createElement('div');
  reason.textContent = capabilities.reason;

  const note = document.createElement('div');
  note.textContent =
    'Every answer works without one. A translator only translates — it is never the source of a fact, ' +
    'and meanings are ranked against the page here, with no model at all.';

  box.append(headline, reason, note);
}

/**
 * What to do when the browser exposes no translator at all.
 *
 * The on-device translator is the nicest answer and the least available one,
 * so this says what works *here* first and leaves the browser switch as a
 * footnote. Measured, because the obvious advice is wrong twice over: Brave's
 * flags page lists 760 experiments and not one of them is the translation
 * API — it exists only as a launch argument, which applies to that launch and
 * no other, and is therefore not something to build a daily habit on.
 */
function showAbsentTranslator(): void {
  const row = $('translationRow');
  // Replaced, not appended. This runs again on every change of the language
  // select, so a reader who tried three languages was shown the same two
  // lists three times with no way to clear them short of a reload.
  for (const stale of row.parentElement?.querySelectorAll('[data-advice]') ?? []) stale.remove();
  row.parentElement?.append(
    turningOn('Nothing needs it', [
      'Turkish head-words come from the dictionary sources and are already on.',
      'An installed dictionary pack answers offline, with no allowance at all.',
      'For whole sentences, switch on the online translator above.',
    ]),
    turningOn('If you want it anyway', [
      'Chrome 138 and later expose the translator with no switch at all — load the extension there and press Download.',
      'Brave has no setting for it. It is a launch argument, so it would apply only to launches started that way.',
    ]),
  );
}

function turningOn(title: string, steps: string[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.dataset.advice = '';
  const heading = document.createElement('div');
  heading.className = 'headline';
  heading.textContent = title;
  const list = document.createElement('ol');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  wrap.append(heading, list);
  return wrap;
}

/**
 * Status of the language pair the gloss is written in, and the one control
 * that can change it.
 *
 * A language pack is a large download that the browser only performs when
 * asked, so it needs a button: without one the translate path could never
 * become live no matter how long the reader waited. Every state the browser
 * can report gets its own sentence, because "unavailable" and "not
 * downloaded yet" call for completely different actions.
 */
async function renderTranslation(): Promise<void> {
  const label = $('translationLabel');
  const button = $<HTMLButtonElement>('downloadTranslation');
  const target = fields.glossLanguage.value;
  const name = fields.glossLanguage.selectedOptions[0]?.textContent ?? target;

  const show = (text: string, offer: boolean) => {
    label.textContent = text;
    button.hidden = !offer;
    button.disabled = !offer;
  };

  show('Checking the translation model…', false);
  const state = await translationAvailability('en', target);

  switch (state) {
    case 'available':
      show(`English to ${name} is ready and runs on this device.`, false);
      return;
    case 'downloadable':
      show(`English to ${name} needs a one-time download.`, true);
      break;
    case 'downloading':
      show(`English to ${name} is downloading. It will start working on its own.`, false);
      return;
    case 'absent':
      show('This browser does not expose a built-in translator.', false);
      showAbsentTranslator();
      return;
    default:
      show(`This device cannot run English to ${name} translation.`, false);
      return;
  }

  button.onclick = async () => {
    button.disabled = true;
    label.textContent = `Downloading English to ${name}…`;
    const settled = await downloadTranslation('en', target, (fraction) => {
      label.textContent = `Downloading English to ${name}… ${Math.round(fraction * 100)}%`;
    });
    if (settled === 'available') {
      show(`English to ${name} is ready and runs on this device.`, false);
    } else {
      // Refused, cancelled or failed. Say so and leave the button usable.
      show(`The download did not finish. English to ${name} is still unavailable.`, true);
    }
  };
}

/**
 * Installing a dictionary pack.
 *
 * Two steps with the reader in between: the files are read and reported on,
 * then installed. The language pair is a guess from the file name and the
 * guess is wrong for anything not named the way FreeDict names things — and
 * a pack installed under the wrong pair answers with the right words in a
 * card that claims they are another language.
 */
let pending: PackPreview | undefined;

const packFields = {
  files: $<HTMLInputElement>('packFiles'),
  form: $('packForm'),
  name: $<HTMLInputElement>('packName'),
  source: $<HTMLInputElement>('packSource'),
  target: $<HTMLInputElement>('packTarget'),
  install: $<HTMLButtonElement>('packInstall'),
  status: $('packStatus'),
};

function renderPacks(packs: PackMeta[]): void {
  const list = $<HTMLUListElement>('packs');
  list.replaceChildren();

  if (packs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No packs installed.';
    list.append(empty);
    return;
  }

  for (const pack of packs) {
    const item = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = pack.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const pair = pack.source === pack.target ? pack.source : `${pack.source} → ${pack.target}`;
    meta.textContent = `${pair} · ${pack.entries.toLocaleString()} words · ${pack.format}`;

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      // Asked first, because getting it back means repeating the three-step
      // download-and-unpack this page documents, outside the browser.
      const words = pack.entries.toLocaleString();
      if (!confirm(`Remove ${pack.name}? Its ${words} words go with it, and re-installing means finding the file again.`)) {
        return;
      }
      void removePack(pack.id)
        .then(() => ext.runtime.sendMessage({ type: 'QL_PACKS_CHANGED' }))
        .then(() => listPacks())
        .then((packs) => {
          renderPacks(packs);
          // The button that was pressed no longer exists, so focus would
          // fall to the body and the next Tab would restart at the top of
          // the page. The file input is the stable thing next to the list.
          packFields.files.focus();
          $('packStatus').textContent = `Removed ${pack.name}.`;
        });
    });

    item.append(name, meta, remove);
    list.append(item);
  }
}

packFields.files.addEventListener('change', () => {
  const files = [...(packFields.files.files ?? [])];
  packFields.form.hidden = true;
  pending = undefined;
  if (files.length === 0) return;

  const classified = classifyFiles(files);
  if (typeof classified === 'string') {
    packFields.status.textContent = classified;
    return;
  }

  packFields.status.textContent = 'Reading…';
  void readPack(classified)
    .then((preview) => {
      if (preview.records.length === 0) {
        packFields.status.textContent =
          'That is the right kind of file, but no entries could be read from it.';
        return;
      }
      pending = preview;
      packFields.name.value = preview.name;
      packFields.source.value = preview.source;
      packFields.target.value = preview.target;
      packFields.status.textContent =
        `${preview.records.length.toLocaleString()} entries. Check the languages, then install.`;
      packFields.form.hidden = false;
    })
    .catch((error: Error) => {
      packFields.status.textContent = `Could not read it: ${error.message}`;
    });
});

packFields.install.addEventListener('click', () => {
  if (!pending) return;
  const chosen = {
    name: packFields.name.value.trim() || pending.name,
    source: packFields.source.value.trim().toLowerCase() || 'en',
    target: packFields.target.value.trim().toLowerCase() || 'en',
  };

  packFields.install.disabled = true;
  void installPack(pending, chosen, (done, total) => {
    packFields.status.textContent = `Installing… ${Math.round((done / total) * 100)}%`;
  })
    .then((meta) => {
      packFields.status.textContent = `Installed ${meta.entries.toLocaleString()} words.`;
      packFields.form.hidden = true;
      packFields.files.value = '';
      pending = undefined;
      return ext.runtime.sendMessage({ type: 'QL_PACKS_CHANGED' });
    })
    .then(() => listPacks())
    .then(renderPacks)
    .catch((error: Error) => {
      packFields.status.textContent = `Could not install it: ${error.message}`;
    })
    .finally(() => {
      packFields.install.disabled = false;
    });
});

void listPacks().then(renderPacks);

function flashSaved(): void {
  const saved = $('saved');
  // Written on each save rather than left in the markup at opacity zero. A
  // live region announces a *change*, so a word that is always there is
  // never read out — and it sat in the accessibility tree permanently, so
  // the page claimed "Saved" from the moment it opened.
  saved.textContent = 'Saved';
  saved.classList.add('show');
  setTimeout(() => {
    saved.classList.remove('show');
    saved.textContent = '';
  }, 1400);
}

$('save').addEventListener('click', () => {
  // The key is written separately because it is stored separately: settings
  // go to `sync` and replicate to every signed-in browser, and a key must
  // not travel that way.
  void saveKeyIfTyped()
    .then(() => ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }))
    .then((current) => {
      // Everything this page does not own is taken from storage at the
      // moment of saving, not from the copy read when the tab was opened.
      // `collect()` spreads that base, so a per-site rule the popup wrote
      // while this tab sat open used to be deleted by pressing Save here.
      settings = mergeSettings(current);
      return ext.runtime.sendMessage({ type: 'QL_SAVE_SETTINGS', settings: collect() });
    })
    .then((stored) => {
      fill(mergeSettings(stored));
      flashSaved();
    });
});

$('reset').addEventListener('click', () => {
  // Every setting and every per-site rule, on one click, with no undo.
  if (!confirm('Reset every setting, including per-site rules, to its default?')) return;
  void ext.runtime
    .sendMessage({ type: 'QL_SAVE_SETTINGS', settings: structuredClone(DEFAULT_SETTINGS) })
    .then((stored) => {
      fill(mergeSettings(stored));
      flashSaved();
    });
});

void ext.runtime.sendMessage({ type: 'QL_GET_SETTINGS' }).then((stored) => {
  fill(mergeSettings(stored));
});

void ext.runtime.sendMessage({ type: 'QL_GET_STATUS' }).then((status: StatusResponse) => {
  renderStatus(status);
});

// The pair depends on the chosen language, so the status follows the select
// rather than only the page load.
fields.glossLanguage.addEventListener('change', () => void renderTranslation());
void renderTranslation();

/**
 * Neither the service nor the address means anything while the online
 * translator is switched off, and the address only reaches MyMemory.
 */
function syncOnlineFields(): void {
  const online = fields.onlineTranslation.checked;
  fields.translationService.disabled = !online;
  fields.translationEmail.disabled = !online || fields.translationService.value === 'google';
}
fields.onlineTranslation.addEventListener('change', syncOnlineFields);
fields.translationService.addEventListener('change', syncOnlineFields);
syncOnlineFields();

void renderKeyState();
