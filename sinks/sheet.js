// agent-stable · Google Sheet sink — appends usage events to a Usage tab and decision events
// to a Decisions tab. The AUTHENTICATED sheets client is injected by the host (boundary rule:
// no auth/keys in agent-stable). Row shapes match the host's existing tabs exactly, so all
// downstream consumers (aggregations, CI) keep working unchanged:
//   Usage:     [at, host, module, model, input, output, costUsd, note]
//   Decisions: [at, host, module, actor, decision, why, parent, taskRef, costUsd]
// Unknown numbers arrive as null (see meter.js) and are written as '' — the blank cell these
// tabs have always held — so rows stay byte-identical for existing readers.
const cell = v => (v === null || v === undefined ? '' : v);
function sheetSink({ sheets, spreadsheetId, usageTab = 'Usage', decisionsTab = 'Decisions' }) {
  if (!sheets || !spreadsheetId) throw new Error('sheetSink needs { sheets, spreadsheetId }');
  const append = (tab, row) => sheets.spreadsheets.values.append({
    spreadsheetId, range: `'${tab}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
  return {
    async record(e) {
      if (e.type === 'decision') {
        await append(decisionsTab, [e.at, e.host, e.module, e.actor, e.decision, e.why, e.parent, e.taskRef, cell(e.costUsd)]);
      } else {
        await append(usageTab, [e.at, e.host, e.module, e.model, cell(e.input), cell(e.output), cell(e.costUsd), e.note]);
      }
      return e;
    },
  };
}
module.exports = { sheetSink };
