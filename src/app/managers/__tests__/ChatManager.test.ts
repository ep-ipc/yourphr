import { beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@medplum/fhirtypes';
import { Engine } from '../../../framework/Engine.js';
import { ApiContext, ApiError } from '../../../framework/ApiContext.js';
import { ConfigurationManager } from '../../../framework/ConfigurationManager.js';
import { PolicyManager } from '../../../framework/managers/PolicyManager.js';
import { FakeConfigProvider } from '../../../framework/providers/__tests__/FakeConfigProvider.js';
import { RecordsManager } from '../RecordsManager.js';
import { FakeRecordsProvider } from '../../providers/__tests__/FakeRecordsProvider.js';
import { FakeChatProvider } from '../../providers/__tests__/FakeChatProvider.js';
import { NullChatProvider } from '../../providers/BaseChatProvider.js';
import { ChatManager } from '../ChatManager.js';

const obs = (id: string, display: string, date: string): Resource =>
  ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '718-7', display }] }, effectiveDateTime: date }) as Resource;

let provider: FakeChatProvider;
let recordsProvider: FakeRecordsProvider;
let engine: Engine;
let records: RecordsManager;
let chat: ChatManager;
let alice: ApiContext;
let bob: ApiContext;
let anonymous: ApiContext;

async function boot(chatProvider: FakeChatProvider | NullChatProvider = provider): Promise<void> {
  engine = new Engine();
  recordsProvider = new FakeRecordsProvider();
  records = new RecordsManager(engine, recordsProvider);
  chat = new ChatManager(engine, chatProvider);
  engine
    .register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(), { env: {} }))
    .register('policy', new PolicyManager(engine))
    .register('records', records)
    .register('chat', chat);
  await engine.initialize();
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  bob = ApiContext.from({ username: 'bob', role: 'user' }, engine);
  anonymous = ApiContext.anonymous(engine);
}

beforeEach(async () => {
  provider = new FakeChatProvider();
  await boot();
  recordsProvider.seed('alice', 'source-1', obs('o1', 'Hemoglobin', '2024-01-10'));
  recordsProvider.seed('alice', 'source-1', obs('o2', 'Glucose', '2024-05-10'));
  recordsProvider.seed('bob', 'source-9', obs('o9', 'Hemoglobin', '2025-01-01'));
});

describe('ChatManager — one door, and it only ever answers for whoever is asking', () => {
  it('brings the provider up at boot', () => {
    expect(provider.initializeCalled).toBe(1);
    expect(chat.available()).toBe(true);
    expect(chat.unavailable()).toBe('');
  });

  it('refuses an anonymous caller before it reaches the provider', async () => {
    await expect(chat.ask(anonymous, 'what am I taking?')).rejects.toThrow(ApiError);
    expect(provider.asked).toHaveLength(0);
  });

  it('asks for the caller, and never for anyone else', async () => {
    await chat.ask(alice, 'what am I taking?');
    await chat.ask(bob, 'and me?');
    expect(provider.asked).toEqual([
      { userId: 'alice', question: 'what am I taking?' },
      { userId: 'bob', question: 'and me?' },
    ]);
  });

  it('will not continue a conversation belonging to another account', async () => {
    const { conversationId } = await chat.ask(alice, 'mine');
    // The leak this port exists to close: bob naming alice's conversation id.
    await expect(chat.ask(bob, 'let me see', conversationId)).rejects.toMatchObject({ status: 404 });
    expect(await chat.messages(bob, conversationId)).toEqual([]);
    expect(await chat.forget(bob, conversationId)).toBe(false);
    // Still alice's, untouched.
    expect(await chat.messages(alice, conversationId)).toHaveLength(2);
  });

  it('lists only the caller’s conversations', async () => {
    await chat.ask(alice, 'mine');
    await chat.ask(bob, 'also mine');
    expect((await chat.conversations(alice)).map((c) => c.firstMessage)).toEqual(['mine']);
    expect((await chat.conversations(bob)).map((c) => c.firstMessage)).toEqual(['also mine']);
  });

  it('rejects an empty question and an oversized one without calling the model', async () => {
    await expect(chat.ask(alice, '   ')).rejects.toMatchObject({ status: 400 });
    await expect(chat.ask(alice, 'x'.repeat(4_001))).rejects.toMatchObject({ status: 400 });
    expect(provider.asked).toHaveLength(0);
  });

  it('reports a model failure as a gateway error rather than a crash', async () => {
    provider.failAsk = 'the model timed out';
    await expect(chat.ask(alice, 'anything?')).rejects.toMatchObject({ status: 502 });
  });

  describe('when no provider is configured', () => {
    beforeEach(async () => { await boot(new NullChatProvider()); });

    it('is unavailable with a reason, and refuses with it', async () => {
      expect(chat.available()).toBe(false);
      expect(chat.unavailable()).toContain('not configured');
      await expect(chat.ask(alice, 'anything?')).rejects.toMatchObject({ status: 503 });
    });

    it('still answers the list — an empty chat page, not a broken one', async () => {
      expect(await chat.conversations(alice)).toEqual([]);
    });
  });

  describe('when the sidecar is down at boot', () => {
    beforeEach(async () => {
      provider = new FakeChatProvider();
      provider.failInitialize = 'connection refused';
      await boot();
    });

    it('boots anyway, degraded, and says why', async () => {
      expect(engine.isInitialized()).toBe(true);
      expect(chat.available()).toBe(false);
      expect(chat.unavailable()).toContain('connection refused');
      await expect(chat.ask(alice, 'anything?')).rejects.toMatchObject({ status: 503 });
    });
  });
});

describe('ChatManager — what a record says', () => {
  it('shapes a record with the title and date the record pages use', () => {
    const text = ChatManager.textOf(
      { resourceType: 'Observation', id: 'o1', sourceId: 'source-1', lastUpdated: '2024-01-10T00:00:00Z', resource: obs('o1', 'Hemoglobin', '2024-01-10') },
      { sort_title: 'Hemoglobin' }
    );
    expect(text).not.toContain('{');
    // The NAME has to be in there. textFor() alone drops it — it skips the whole `code` subtree —
    // which is why the display title is prepended. See ChatManager.textOf.
    expect(text).toContain('Hemoglobin');
  });

  it('carries the measured value and unit into the text the model reads', () => {
    const resource = { resourceType: 'Observation', id: 'o7', status: 'final', code: { text: 'Hemoglobin', coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] }, valueQuantity: { value: 13.5, unit: 'g/dL' }, effectiveDateTime: '2024-01-10' } as Resource;
    const text = ChatManager.textOf({ resourceType: 'Observation', id: 'o7', sourceId: 'source-1', lastUpdated: '2024-01-10T00:00:00Z', resource }, { sort_title: 'Hemoglobin' });
    expect(text).toContain('13.5');
    expect(text).toContain('g/dL');
  });

  it("says what KIND of record it is, in a patient's words", () => {
    const condition = { resourceType: 'Condition', id: 'c9', code: { text: 'Hypertension', coding: [{ display: 'Hypertension' }] }, recordedDate: '2024-07-01' } as Resource;
    const text = ChatManager.textOf({ resourceType: 'Condition', id: 'c9', sourceId: 'source-1', lastUpdated: '2024-07-01T00:00:00Z', resource: condition }, { sort_title: 'Hypertension' });
    // Without this the model answered "what have I been diagnosed with" with a list of blood tests.
    expect(text.startsWith('Diagnosis:')).toBe(true);
    expect(text).toContain('Hypertension');

    const measurement = ChatManager.textOf({ resourceType: 'Observation', id: 'o8', sourceId: 'source-1', lastUpdated: '2024-01-10T00:00:00Z', resource: obs('o8', 'Hemoglobin', '2024-01-10') }, { sort_title: 'Hemoglobin' });
    expect(measurement.startsWith('Test result or measurement:')).toBe(true);
  });

  it('keeps billing out of an answer — it is not medicine, and it crowds out what is', () => {
    // In one Synthea bundle these were 10,917 of ~20,000 indexed characters, against 193 for all
    // three of the patient's diagnoses.
    expect(ChatManager.isClinical('Claim')).toBe(false);
    expect(ChatManager.isClinical('ExplanationOfBenefit')).toBe(false);
    expect(ChatManager.isClinical('Coverage')).toBe(false);
    expect(ChatManager.isClinical('Condition')).toBe(true);
    expect(ChatManager.isClinical('MedicationRequest')).toBe(true);
  });
});
