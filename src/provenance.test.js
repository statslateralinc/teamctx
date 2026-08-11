import { describe, it, expect } from 'vitest';
import {
  collectContributorCounts, collectSourceRefs,
  formatContributorLine, formatContributorsSection, formatAuditBlock,
  preserveSourcesThroughReflect,
} from './provenance.js';

const contributions = [
  { id: 'c-1', author: 'shikhin', ts: '2026-06-01T10:00:00Z', source: 'cli',  tagged: null, text: 'CAC on Google keeps rising' },
  { id: 'c-2', author: 'rajeev',  ts: '2026-06-08T10:00:00Z', source: 'web',  tagged: null, text: 'LinkedIn ROAS trending up' },
  { id: 'c-3', author: 'priya',   ts: '2026-06-14T10:00:00Z', source: 'cli',  tagged: 'decision', text: 'Pause paid ads on Google' },
  { id: 'c-4', author: 'priya',   ts: '2026-06-15T10:00:00Z', source: 'cli',  tagged: null, text: 'Reallocate budget to LinkedIn' },
];

const workstream = {
  id: 'main',
  name: 'Main',
  whys: [
    {
      id: 'w1', text: 'grow revenue', sourceContributionIds: ['c-3', 'c-4'],
      whats: [
        {
          id: 'wt1', text: 'double down on LinkedIn', sourceContributionIds: ['c-2', 'c-4'],
          hows: [
            { id: 'h1', text: 'reallocate spend', sourceContributionIds: ['c-1'] },
          ],
        },
      ],
    },
  ],
};

describe('backwards compatibility with pre-provenance projects', () => {
  it('handles nodes without sourceContributionIds (legacy schema) — no crash, empty footer', () => {
    const legacyWs = { id: 'main', name: 'M', whys: [
      { id: 'w1', text: 'legacy why', whats: [{ id: 'wt1', text: 'legacy what', hows: [{ id: 'h1', text: 'legacy how' }] }] },
    ]};
    expect(collectContributorCounts(legacyWs, contributions)).toEqual([]);
    expect(collectSourceRefs(legacyWs, contributions)).toEqual({ sources: [], unknown: [] });
    expect(formatContributorLine([])).toBe('');
  });

  it('handles contributions without tagged / source / author fields', () => {
    const oldContribs = [{ id: 'c-old', text: 'legacy entry' }];
    const ws = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 't', sourceContributionIds: ['c-old'], whats: [] }] };
    expect(collectContributorCounts(ws, oldContribs)).toEqual([]);
    const { sources } = collectSourceRefs(ws, oldContribs);
    expect(sources[0]).toMatchObject({ author: 'unknown', source: 'cli', tagged: null });
  });

  it('handles missing contributions.jsonl entries (id references a deleted contribution)', () => {
    const ws = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 't', sourceContributionIds: ['c-ghost'], whats: [] }] };
    const { sources, unknown } = collectSourceRefs(ws, []);
    expect(sources).toEqual([]);
    expect(unknown).toEqual(['c-ghost']);
    expect(formatAuditBlock({ sources, unknown })).toContain('unknown');
  });
});

describe('collectContributorCounts', () => {
  it('counts distinct contributions per author, marks decisions, sorts by total desc', () => {
    const counts = collectContributorCounts(workstream, contributions);
    expect(counts).toEqual([
      { author: 'priya', total: 2, decisions: 1 },
      { author: 'rajeev', total: 1, decisions: 0 },
      { author: 'shikhin', total: 1, decisions: 0 },
    ]);
  });

  it('returns [] when workstream has no nodes', () => {
    expect(collectContributorCounts({ whys: [] }, contributions)).toEqual([]);
  });

  it('ignores contribution ids that resolve to nothing', () => {
    const ws = { whys: [{ id: 'w1', text: 't', sourceContributionIds: ['ghost'], whats: [] }] };
    expect(collectContributorCounts(ws, contributions)).toEqual([]);
  });
});

describe('collectSourceRefs', () => {
  it('flattens sources across all node tiers, dedupes per contribution id, sorts by ts', () => {
    const { sources, unknown } = collectSourceRefs(workstream, contributions);
    expect(unknown).toEqual([]);
    expect(sources.map(s => s.contributionId)).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
    expect(sources[2].tagged).toBe('decision');
    expect(sources[0].nodes[0].tier).toBe('how');
    const cFour = sources.find(s => s.contributionId === 'c-4');
    expect(cFour.nodes).toHaveLength(2);
  });

  it('reports unknown ids that don\'t resolve', () => {
    const ws = { whys: [{ id: 'w1', text: 't', sourceContributionIds: ['ghost'], whats: [] }] };
    const { sources, unknown } = collectSourceRefs(ws, contributions);
    expect(sources).toEqual([]);
    expect(unknown).toEqual(['ghost']);
  });
});

describe('formatContributorLine', () => {
  it('renders "author (N, K decisions)" with comma joins, most active first', () => {
    const counts = collectContributorCounts(workstream, contributions);
    expect(formatContributorLine(counts)).toBe('**Contributions from:** priya (2, 1 decision), rajeev (1), shikhin (1)');
  });

  it('returns empty string when no counts', () => {
    expect(formatContributorLine([])).toBe('');
  });
});

describe('formatContributorsSection', () => {
  it('renders a markdown block with per-author counts', () => {
    const counts = collectContributorCounts(workstream, contributions);
    const out = formatContributorsSection(counts);
    expect(out).toContain('## Contributors');
    expect(out).toContain('- **priya** — 2 contributions (1 decision)');
    expect(out).toContain('- **shikhin** — 1 contribution');
  });

  it('returns empty string when no counts', () => {
    expect(formatContributorsSection([])).toBe('');
  });
});

describe('preserveSourcesThroughReflect', () => {
  const previous = {
    id: 'main', name: 'M',
    whys: [
      { id: 'w1', text: 'grow', sourceContributionIds: ['c-1', 'c-2'],
        whats: [{ id: 'wt1', text: 'a', sourceContributionIds: ['c-3'], hows: [] }] },
      { id: 'w2', text: 'ship', sourceContributionIds: ['c-4'], whats: [] },
    ],
  };

  it('keeps source ids on nodes whose ids the AI kept', () => {
    const next = {
      id: 'main', name: 'M',
      whys: [{ id: 'w1', text: 'grow revenue', sourceContributionIds: [], whats: [] }],
    };
    const result = preserveSourcesThroughReflect(previous, next);
    expect(result.whys[0].sourceContributionIds).toEqual(['c-1', 'c-2']);
  });

  it('merges (not overwrites) if the AI already added new source ids', () => {
    const next = {
      id: 'main', name: 'M',
      whys: [{ id: 'w1', text: 'grow revenue', sourceContributionIds: ['c-new'], whats: [] }],
    };
    const result = preserveSourcesThroughReflect(previous, next);
    expect(result.whys[0].sourceContributionIds).toEqual(['c-1', 'c-2', 'c-new']);
  });

  it('keeps sources on nested whats and hows too', () => {
    const next = {
      id: 'main', name: 'M',
      whys: [{ id: 'w1', text: 'g', sourceContributionIds: [],
        whats: [{ id: 'wt1', text: 'aa', sourceContributionIds: [], hows: [] }] }],
    };
    const result = preserveSourcesThroughReflect(previous, next);
    expect(result.whys[0].whats[0].sourceContributionIds).toEqual(['c-3']);
  });

  it('leaves brand-new nodes untouched (no previous match)', () => {
    const next = {
      id: 'main', name: 'M',
      whys: [{ id: 'w-brand-new', text: 'x', sourceContributionIds: ['c-fresh'], whats: [] }],
    };
    const result = preserveSourcesThroughReflect(previous, next);
    expect(result.whys[0].sourceContributionIds).toEqual(['c-fresh']);
  });
});

describe('formatAuditBlock', () => {
  it('renders each source with date, source system, decision tag, and snippet', () => {
    const { sources, unknown } = collectSourceRefs(workstream, contributions);
    const block = formatAuditBlock({ sources, unknown });
    expect(block).toContain('**Sources**');
    expect(block).toContain('- shikhin, 2026-06-01 (cli) — CAC on Google keeps rising');
    expect(block).toContain('- **decision** — priya, 2026-06-14 (cli) — Pause paid ads on Google');
  });

  it('flags unknown sources at the bottom', () => {
    const block = formatAuditBlock({ sources: [], unknown: ['ghost'] });
    expect(block).toContain('1 source unknown');
  });

  it('returns empty string when nothing to render', () => {
    expect(formatAuditBlock({ sources: [], unknown: [] })).toBe('');
  });
});


describe('collectContributorCounts — identity across surfaces', () => {
  const ws = {
    whys: [{
      id: 'w1', text: 'why', sourceContributionIds: ['k-1', 'k-2', 'k-3'],
      whats: [],
    }],
  };

  it('counts one person once even when their display name differs per surface', () => {
    // Same human: git name from the CLI, GitHub name from the hosted server.
    const contribs = [
      { id: 'k-1', author: 'Satyagya Singh', authorKey: 'github:42', ts: '2026-06-01T00:00:00Z' },
      { id: 'k-2', author: 'satya',          authorKey: 'github:42', ts: '2026-06-02T00:00:00Z' },
      { id: 'k-3', author: 'other',          authorKey: 'github:99', ts: '2026-06-03T00:00:00Z' },
    ];
    const counts = collectContributorCounts(ws, contribs);
    expect(counts).toHaveLength(2);
    expect(counts.find(c => c.total === 2)).toMatchObject({ author: 'satya', total: 2 });
  });

  it('uses the most recent display name for a key', () => {
    const contribs = [
      { id: 'k-1', author: 'old name', authorKey: 'github:42', ts: '2026-06-01T00:00:00Z' },
      { id: 'k-2', author: 'new name', authorKey: 'github:42', ts: '2026-07-01T00:00:00Z' },
      { id: 'k-3', author: 'new name', authorKey: 'github:42', ts: '2026-06-15T00:00:00Z' },
    ];
    expect(collectContributorCounts(ws, contribs)[0].author).toBe('new name');
  });

  it('groups legacy contributions by author, exactly as before', () => {
    // Written before authorKey existed — no key to group on.
    const contribs = [
      { id: 'k-1', author: 'alice', ts: '2026-06-01T00:00:00Z' },
      { id: 'k-2', author: 'alice', ts: '2026-06-02T00:00:00Z' },
      { id: 'k-3', author: 'bob',   ts: '2026-06-03T00:00:00Z' },
    ];
    const counts = collectContributorCounts(ws, contribs);
    expect(counts).toEqual([
      { author: 'alice', total: 2, decisions: 0 },
      { author: 'bob', total: 1, decisions: 0 },
    ]);
  });

  it('keeps a keyed and an unkeyed contribution apart', () => {
    // We cannot prove they are the same person, so we must not merge them.
    const contribs = [
      { id: 'k-1', author: 'alice', ts: '2026-06-01T00:00:00Z' },
      { id: 'k-2', author: 'alice', authorKey: 'github:42', ts: '2026-06-02T00:00:00Z' },
      { id: 'k-3', author: 'bob', ts: '2026-06-03T00:00:00Z' },
    ];
    expect(collectContributorCounts(ws, contribs)).toHaveLength(3);
  });
});
