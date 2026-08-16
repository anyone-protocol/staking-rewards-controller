import { ScoreData } from '../schemas/score-data'

export interface AddScoresData {
  [key: string]: {
    [key: string]: Omit<Omit<ScoreData, 'Operator'>, 'Hodler'>
  }
}

export interface AddScoresResult {
  result: boolean
  stamp: number
  scored: number
}

/**
 * Per-operator relay counts for a round, keyed by operator address.
 *
 * These are already computed to derive each score's `Running` quotient. Sending them to the
 * contract as well makes the network state part of the signed round record instead of only
 * surviving as a lossy ratio: a quotient cannot answer "3 of 5 relays up", and it does not exist
 * at all for an operator nobody has staked to.
 */
export interface NetworkCounts {
  [operatorAddress: string]: {
    Expected: number
    Running: number
    Found: number
  }
}
