/** Transport-authenticated authority identity; rebuilding its database creates a new epoch. */
export interface ResearchAuthorityIdentity {
  schema: 'research-authority-identity-v1'
  epoch: string
}

/** Closing an unknown key must fence a delayed first submission, not merely query absence. */
export interface ResearchAuthorityClosureRequest {
  expectedEpoch: string
  dispatchKey: string
  specHash: string
}

/** A not-started result is backed by a durable same-key tombstone in this exact authority epoch. */
export interface ResearchAuthorityClosureProof extends ResearchAuthorityClosureRequest {
  schema: 'research-authority-closure-v1'
  outcome:
    | 'not_started'
    | 'cancel_requested'
    | 'completion_requested'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'interrupted'
  recordedAt: number
}
