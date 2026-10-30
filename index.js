// agent-stable — public entry point. See README.md for the flow chart and quickstart.
const pricing = require('./pricing');
const { createMeter } = require('./meter');
const { createAdapters, DEFAULT_BASE } = require('./adapters');
const { createApa, DEFAULT_EVAL_PROMPTS } = require('./apa');
const { createBoard, canonical, sameModel, normModel } = require('./board');
const { createTiers, TIER_ORDER } = require('./tiers');
const { memorySink } = require('./sinks/memory');
const { jsonlSink } = require('./sinks/jsonl');
const { sheetSink } = require('./sinks/sheet');

// The package version, so a host that VENDORS this directory (instead of installing it from
// npm) can assert at startup or in CI that its copy is the release it pinned.
const { version: VERSION } = require('./package.json');

module.exports = {
  VERSION,
  pricing,
  createMeter,
  createAdapters, DEFAULT_BASE,
  createApa, DEFAULT_EVAL_PROMPTS,
  createBoard, canonical, sameModel, normModel,
  createTiers, TIER_ORDER,
  sinks: { memorySink, jsonlSink, sheetSink },
};
