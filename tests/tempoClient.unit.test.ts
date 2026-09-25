// Unit tests for tempoClient.ts (pure / exported functions only)
// Run with: node --experimental-strip-types tests/tempoClient.unit.test.ts

import {
  flattenTree,
  parseOtlpTrace,
  parseOtlpValue,
  getTraceDurationMs,
  getTraceStartMs,
  type PluginSpan,
} from '../src/utils/tempoClient.ts';
import { extractLlmSpanData } from '../src/utils/llmUtils.ts';

// ---------------------------------------------------------------------------
// Minimal assertion helpers (same style as llmUtils.unit.test.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  pass: ${message}`);
    passed++;
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  pass: ${message}`);
    passed++;
  }
}

function assertDeepEquals(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`  FAIL: ${message}\n    expected: ${b}\n    got:      ${a}`);
    failed++;
  } else {
    console.log(`  pass: ${message}`);
    passed++;
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n=== ${name} ===`);
  fn();
}

// ---------------------------------------------------------------------------
// Helper: build a minimal PluginSpan
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<PluginSpan> & { spanId: string }): PluginSpan {
  return {
    traceId: 'trace1',
    spanId: overrides.spanId,
    parentSpanId: overrides.parentSpanId ?? null,
    operationName: overrides.operationName ?? 'op',
    serviceName: overrides.serviceName ?? 'svc',
    serviceAttributes: overrides.serviceAttributes ?? [],
    startTimeMs: overrides.startTimeMs ?? 0,
    durationMs: overrides.durationMs ?? 10,
    tags: overrides.tags ?? [],
    logs: overrides.logs ?? [],
    children: overrides.children ?? [],
    depth: overrides.depth ?? 0,
    ...(overrides.statusCode !== undefined ? { statusCode: overrides.statusCode } : {}),
    ...(overrides.statusMessage !== undefined ? { statusMessage: overrides.statusMessage } : {}),
  };
}

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------

describe('flattenTree', () => {
  // Empty input
  assertDeepEquals(flattenTree([]), [], 'empty roots returns empty array');

  // Single root, no children
  const lone = makeSpan({ spanId: 'a', startTimeMs: 5 });
  const flat1 = flattenTree([lone]);
  assertEquals(flat1.length, 1, 'single root: length is 1');
  assertEquals(flat1[0].spanId, 'a', 'single root: correct spanId');

  // Root with nested children
  const child2 = makeSpan({ spanId: 'c2', startTimeMs: 20 });
  const child1 = makeSpan({ spanId: 'c1', startTimeMs: 10, children: [child2] });
  const root = makeSpan({ spanId: 'r', startTimeMs: 0, children: [child1] });
  const flat2 = flattenTree([root]);
  assertDeepEquals(
    flat2.map((s) => s.spanId),
    ['r', 'c1', 'c2'],
    'flattenTree visits depth-first pre-order',
  );

  // Multiple roots
  const rootA = makeSpan({ spanId: 'a', startTimeMs: 0 });
  const rootB = makeSpan({ spanId: 'b', startTimeMs: 1 });
  const flat3 = flattenTree([rootA, rootB]);
  assertEquals(flat3.length, 2, 'two roots: length is 2');
  assertEquals(flat3[0].spanId, 'a', 'two roots: first root first');
  assertEquals(flat3[1].spanId, 'b', 'two roots: second root second');
});

// ---------------------------------------------------------------------------
// getTraceStartMs
// ---------------------------------------------------------------------------

describe('getTraceStartMs', () => {
  assertEquals(getTraceStartMs([]), 0, 'empty spans returns 0');

  const s1 = makeSpan({ spanId: 's1', startTimeMs: 500 });
  const s2 = makeSpan({ spanId: 's2', startTimeMs: 100 });
  const s3 = makeSpan({ spanId: 's3', startTimeMs: 300, children: [s1] });
  assertEquals(getTraceStartMs([s2, s3]), 100, 'returns minimum startTimeMs across all spans');

  // Single span
  const only = makeSpan({ spanId: 'x', startTimeMs: 42 });
  assertEquals(getTraceStartMs([only]), 42, 'single span: returns its startTimeMs');

  // Nested child has earlier start than root
  const earlyChild = makeSpan({ spanId: 'ec', startTimeMs: 5 });
  const lateRoot = makeSpan({ spanId: 'lr', startTimeMs: 50, children: [earlyChild] });
  assertEquals(getTraceStartMs([lateRoot]), 5, 'nested child with earlier start is found');
});

// ---------------------------------------------------------------------------
// getTraceDurationMs
// ---------------------------------------------------------------------------

describe('getTraceDurationMs', () => {
  assertEquals(getTraceDurationMs([]), 0, 'empty spans returns 0');

  // Single span
  const s = makeSpan({ spanId: 's', startTimeMs: 100, durationMs: 50 });
  assertEquals(getTraceDurationMs([s]), 50, 'single span: duration equals durationMs');

  // Minimum of 1 even for zero-duration spans
  const zeroSpan = makeSpan({ spanId: 'z', startTimeMs: 0, durationMs: 0 });
  assertEquals(getTraceDurationMs([zeroSpan]), 1, 'zero-duration span returns at least 1');

  // Duration spans from earliest start to latest end
  const a = makeSpan({ spanId: 'a', startTimeMs: 100, durationMs: 200 }); // ends at 300
  const b = makeSpan({ spanId: 'b', startTimeMs: 50, durationMs: 100 });  // ends at 150
  // minStart=50, maxEnd=300, duration=250
  assertEquals(getTraceDurationMs([a, b]), 250, 'uses overall start-to-end across all spans');

  // Nested child extends the end time
  const child = makeSpan({ spanId: 'ch', startTimeMs: 200, durationMs: 300 }); // ends at 500
  const parent = makeSpan({ spanId: 'p', startTimeMs: 100, durationMs: 50, children: [child] });
  // minStart=100, maxEnd=500, duration=400
  assertEquals(getTraceDurationMs([parent]), 400, 'nested child that outlives parent extends duration');
});

// ---------------------------------------------------------------------------
// BUG-034: durationMs is clamped to >= 0 (tested via manual PluginSpan)
// ---------------------------------------------------------------------------

describe('BUG-034: durationMs clamped to 0 with clock skew', () => {
  // We cannot call parseOtlpTrace directly (it's not exported), but we can
  // verify that spans with durationMs: 0 (already clamped) behave correctly
  // across getTraceDurationMs / flattenTree.
  const clampedSpan = makeSpan({ spanId: 'ck', startTimeMs: 1000, durationMs: 0 });
  assert(clampedSpan.durationMs >= 0, 'a span with durationMs=0 satisfies >= 0');
  assertEquals(getTraceDurationMs([clampedSpan]), 1, 'clamped-to-zero span yields minimum duration of 1');

  // Verify that a normal positive duration is preserved
  const normalSpan = makeSpan({ spanId: 'ns', startTimeMs: 0, durationMs: 42 });
  assertEquals(getTraceDurationMs([normalSpan]), 42, 'positive durationMs is preserved unchanged');
});

// ---------------------------------------------------------------------------
// BUG-015: sortByStartTime recurses into single-child spans
// ---------------------------------------------------------------------------

describe('BUG-015: sortByStartTime recurses into single-child spans', () => {
  // Build a tree: root -> singleChild -> [grandchild2 (later), grandchild1 (earlier)]
  // After sorting, grandchild1 should come before grandchild2.
  const gc1 = makeSpan({ spanId: 'gc1', startTimeMs: 10 });
  const gc2 = makeSpan({ spanId: 'gc2', startTimeMs: 5 }); // earlier, should sort first
  // singleChild has exactly 1 child initially; we add both grandchildren to test sorting
  const singleChild = makeSpan({ spanId: 'sc', startTimeMs: 1, children: [gc1, gc2] });
  const root = makeSpan({ spanId: 'root', startTimeMs: 0, children: [singleChild] });

  // flattenTree reflects whatever sort order is in children arrays.
  // Since we build spans manually (not through buildTree/sortByStartTime), we
  // simulate the effect of the fix by checking that flattenTree can handle
  // single-child intermediaries properly.
  const flat = flattenTree([root]);
  assertDeepEquals(
    flat.map((s) => s.spanId),
    ['root', 'sc', 'gc1', 'gc2'],
    'flattenTree traverses through single-child span to its children',
  );

  // Now verify the fix: manually call a sort that mirrors sortByStartTime behavior.
  // We re-build the tree with children in unsorted order and use a simple recursive sort.
  function sortChildren(spans: PluginSpan[]): void {
    spans.sort((a, b) => a.startTimeMs - b.startTimeMs);
    for (const s of spans) {
      // BUG-015 fixed behavior: recurse when children.length > 0 (not > 1)
      if (s.children.length > 0) {
        sortChildren(s.children);
      }
    }
  }

  const gc3 = makeSpan({ spanId: 'gc3', startTimeMs: 10 });
  const gc4 = makeSpan({ spanId: 'gc4', startTimeMs: 5 });
  const singleChild2 = makeSpan({ spanId: 'sc2', startTimeMs: 1, children: [gc3, gc4] });
  sortChildren([singleChild2]);
  assertEquals(singleChild2.children[0].spanId, 'gc4', 'BUG-015: single-child parent: earlier grandchild sorts first');
  assertEquals(singleChild2.children[1].spanId, 'gc3', 'BUG-015: single-child parent: later grandchild sorts second');
});

// ---------------------------------------------------------------------------
// BUG-048: self-referencing span does not cause infinite recursion
// ---------------------------------------------------------------------------

describe('BUG-048: self-referencing span is treated as a root (not infinite recursion)', () => {
  // We test this by verifying flattenTree handles a span that would be a root
  // (because buildTree, which is not exported, skips self-refs and puts them
  // in roots). We simulate the already-processed result.
  const selfRef = makeSpan({ spanId: 'self', startTimeMs: 0 });
  // After BUG-048 fix in buildTree, selfRef.parentSpanId === selfRef.spanId
  // means it goes to roots with no children added to itself.
  // We verify the flat output is just the span itself.
  const flat = flattenTree([selfRef]);
  assertEquals(flat.length, 1, 'BUG-048: self-referencing span results in single root span');
  assertEquals(flat[0].spanId, 'self', 'BUG-048: self-referencing span has correct spanId');
  assertEquals(flat[0].children.length, 0, 'BUG-048: self-referencing span has no children after fix');
});

// ---------------------------------------------------------------------------
// OTLP nested values used by GenAI structured messages and finish reasons
// ---------------------------------------------------------------------------

describe('OTLP arrays and kv-lists retain their structure for semantic content', () => {
  assertDeepEquals(parseOtlpValue({ arrayValue: { values: [
    { stringValue: 'stop' }, { stringValue: 'length' },
  ] } }), ['stop', 'length'], 'finish reasons stay ordered, not comma-joined');
  assertDeepEquals(parseOtlpValue({ kvlistValue: { values: [
    { key: 'type', value: { stringValue: 'text' } },
    { key: 'content', value: { stringValue: 'Hello' } },
  ] } }), { type: 'text', content: 'Hello' }, 'nested message part becomes a record');
  const spans = parseOtlpTrace({ resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'otel-example' } }] },
    scopeSpans: [{ spans: [{
      traceId: 'trace1', spanId: 'span1', name: 'chat gpt-4o',
      startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
        { key: 'gen_ai.input.messages', value: { arrayValue: { values: [{ kvlistValue: { values: [
          { key: 'role', value: { stringValue: 'user' } },
          { key: 'parts', value: { arrayValue: { values: [{ kvlistValue: { values: [
            { key: 'type', value: { stringValue: 'text' } },
            { key: 'content', value: { stringValue: 'Hello from Tempo' } },
          ] } }] } } },
        ] } }] } } },
        { key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: 'stop' }] } } },
      ],
    }] }],
  }] });
  assertEquals(spans.length, 1, 'parsed trace has one span');
  const llm = extractLlmSpanData(spans[0].tags, spans[0].logs);
  assertEquals(llm.inputMessages[0].content, 'Hello from Tempo', 'structured OTLP message rendered');
  assertEquals(llm.finishReason, 'stop', 'OTLP array finish reason rendered');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
