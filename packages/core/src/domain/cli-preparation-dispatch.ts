export type CliPreparationDispatchState =
  | 'not_sent'
  | 'sending'
  | 'acknowledged'
  | 'observation_unknown'
export interface CliPreparationObserverLease {
  instanceId: string
  generation: number
  expiresAt: number
}
export interface CliPreparationAuthorityBinding {
  schema: 'cli-preparation-authority-binding-v1'
  epoch: string
  backendPolicyHash: string
  jobSpecHash: string
  dispatchState: CliPreparationDispatchState
  observer?: CliPreparationObserverLease
}
export interface CliPreparationObserverIdentity {
  instanceId: string
  generation: number
}
