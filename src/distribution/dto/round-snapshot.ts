import Configuration from './configuration'
import ScoringDetails from './scoring-details'

export default interface RoundSnapshot {
  Timestamp: number // millis
  Period: number // seconds
  Summary: {
    Rewards: string
    Ratings: string
    Stakes: string
  }
  Configuration: Configuration
  Details: {
    [key: string]: ScoringDetails
  }
}
