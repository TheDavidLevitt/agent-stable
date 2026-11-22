// agent-stable — public entry point. See README.md for the flow chart and quickstart.
const pricing = require('./pricing');
const { createMeter } = require('./meter');
const { createAdapters, DEFAULT_BASE } = require('./adapters');
const { createApa, DEFAULT_EVAL_PROMPTS } = require('./apa');
const { createBoard, canonical, sameModel, normModel } = require('./board');
const { createTiers, TIER_ORDER } = require('./tiers');
const fleet = require('./fleet');
const { memorySink } = require('./sinks/memory');
const { jsonlSink } = require('./sinks/jsonl');
const { sheetSink } = require('./sinks/sheet');

module.exports = {
  pricing,
  createMeter,
  createAdapters, DEFAULT_BASE,
  createApa, DEFAULT_EVAL_PROMPTS,
  createBoard, canonical, sameModel, normModel,
  createTiers, TIER_ORDER,
  fleet,
  sinks: { memorySink, jsonlSink, sheetSink },
};
