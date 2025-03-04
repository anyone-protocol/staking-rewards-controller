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
