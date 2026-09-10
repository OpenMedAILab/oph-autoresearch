export const STUDY_GUIDE = {
  question: 'Recommended question',
  PICO: {
    population: 'Data population',
    intervention: 'Model',
    comparison: 'Baseline',
    outcome: 'Endpoint',
  },
  evidenceCitations: ['registered citation ID or evidence contentHash'],
  counterEvidence: ['Alternatives / limitations'],
  protocol: {
    candidates: ['Options and selection reasons'],
    targetVenues: ['Saved venue key'],
    experiments: ['Baselines and ablations'],
    budget: 'Resource limits',
    stopRules: ['Stopping criteria'],
  },
  endpoints: ['Primary endpoint'],
  splitPlan: { unit: 'patient', description: 'Split and leakage controls' },
  codeVersion: 'not prepared',
  revision_note:
    'Required for revisions: changed frozen items and supporting evidence; omit on first version',
  previousVersion: null,
}
